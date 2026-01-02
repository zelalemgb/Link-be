-- Phase 1: Core Role & Permission Infrastructure
-- This migration creates the foundation for a robust, scalable user management system

-- 1.1 Create app_role enum (keeping existing enum for backward compatibility during transition)
-- The existing user_role enum will remain for now, we'll migrate data later

-- 1.2 Create Permissions Table
CREATE TABLE IF NOT EXISTS public.permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_permissions_resource ON public.permissions(resource);
CREATE INDEX IF NOT EXISTS idx_permissions_category ON public.permissions(category);
CREATE INDEX IF NOT EXISTS idx_permissions_name ON public.permissions(name);

COMMENT ON TABLE public.permissions IS 'Granular permissions that can be assigned to roles';
COMMENT ON COLUMN public.permissions.name IS 'Unique permission identifier (e.g., patients.create, billing.approve)';
COMMENT ON COLUMN public.permissions.resource IS 'Resource type (e.g., patients, billing, inventory)';
COMMENT ON COLUMN public.permissions.action IS 'Action type (e.g., create, read, update, delete, approve)';
COMMENT ON COLUMN public.permissions.category IS 'Permission category (clinical, administrative, financial, operational)';

-- 1.3 Create Roles Table
CREATE TABLE IF NOT EXISTS public.roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  scope_level TEXT NOT NULL DEFAULT 'facility',
  parent_role_id UUID REFERENCES public.roles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_scope_level CHECK (scope_level IN ('global', 'tenant', 'facility', 'department'))
);

CREATE INDEX IF NOT EXISTS idx_roles_slug ON public.roles(slug);
CREATE INDEX IF NOT EXISTS idx_roles_scope ON public.roles(scope_level);
CREATE INDEX IF NOT EXISTS idx_roles_parent ON public.roles(parent_role_id) WHERE parent_role_id IS NOT NULL;

COMMENT ON TABLE public.roles IS 'User roles with hierarchical support and scope-based access';
COMMENT ON COLUMN public.roles.slug IS 'URL-safe role identifier matching legacy user_role enum values';
COMMENT ON COLUMN public.roles.is_system_role IS 'True for built-in roles that cannot be deleted';
COMMENT ON COLUMN public.roles.scope_level IS 'Scope of role access: global (system-wide), tenant, facility, or department';
COMMENT ON COLUMN public.roles.parent_role_id IS 'Optional parent role for inheritance hierarchy';

-- 1.4 Create Role-Permission Junction Table
CREATE TABLE IF NOT EXISTS public.role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  UNIQUE(role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON public.role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission ON public.role_permissions(permission_id);

COMMENT ON TABLE public.role_permissions IS 'Maps permissions to roles (many-to-many relationship)';

-- 1.5 Create User-Roles Table (replaces user_role column)
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES public.facilities(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB,
  UNIQUE(user_id, role_id, facility_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON public.user_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_facility ON public.user_roles(facility_id) WHERE facility_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_roles_tenant ON public.user_roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_active ON public.user_roles(is_active, user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_user_roles_expiry ON public.user_roles(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE public.user_roles IS 'Assigns roles to users with facility/tenant scope and temporal control';
COMMENT ON COLUMN public.user_roles.facility_id IS 'Optional facility scope - NULL means role applies across all facilities in tenant';
COMMENT ON COLUMN public.user_roles.expires_at IS 'Optional expiration for temporary role assignments';
COMMENT ON COLUMN public.user_roles.is_active IS 'Flag to enable/disable role without deleting the record';
COMMENT ON COLUMN public.user_roles.metadata IS 'Additional context about the role assignment';

-- 1.6 Create Role Assignments Audit Table
CREATE TABLE IF NOT EXISTS public.role_assignments_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  role_id UUID NOT NULL,
  facility_id UUID,
  tenant_id UUID NOT NULL,
  action TEXT NOT NULL,
  assigned_by UUID,
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_action CHECK (action IN ('assigned', 'revoked', 'expired', 'activated', 'deactivated', 'modified'))
);

CREATE INDEX IF NOT EXISTS idx_role_audit_user ON public.role_assignments_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_role_audit_role ON public.role_assignments_audit(role_id);
CREATE INDEX IF NOT EXISTS idx_role_audit_created ON public.role_assignments_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_role_audit_action ON public.role_assignments_audit(action);
CREATE INDEX IF NOT EXISTS idx_role_audit_assigned_by ON public.role_assignments_audit(assigned_by) WHERE assigned_by IS NOT NULL;

COMMENT ON TABLE public.role_assignments_audit IS 'Complete audit trail of all role assignment changes';
COMMENT ON COLUMN public.role_assignments_audit.action IS 'Type of change: assigned, revoked, expired, activated, deactivated, modified';

-- 1.7 Create trigger to auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_permissions_updated_at
  BEFORE UPDATE ON public.permissions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_roles_updated_at
  BEFORE UPDATE ON public.roles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 1.8 Create trigger to audit role assignments
CREATE OR REPLACE FUNCTION public.audit_role_assignment_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO public.role_assignments_audit (
      user_id, role_id, facility_id, tenant_id, action, assigned_by, metadata
    ) VALUES (
      NEW.user_id, NEW.role_id, NEW.facility_id, NEW.tenant_id, 'assigned', NEW.assigned_by,
      jsonb_build_object('expires_at', NEW.expires_at, 'is_active', NEW.is_active)
    );
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF OLD.is_active = true AND NEW.is_active = false THEN
      INSERT INTO public.role_assignments_audit (
        user_id, role_id, facility_id, tenant_id, action, assigned_by, metadata
      ) VALUES (
        NEW.user_id, NEW.role_id, NEW.facility_id, NEW.tenant_id, 'deactivated', NEW.assigned_by,
        jsonb_build_object('previous_state', 'active', 'new_state', 'inactive')
      );
    ELSIF OLD.is_active = false AND NEW.is_active = true THEN
      INSERT INTO public.role_assignments_audit (
        user_id, role_id, facility_id, tenant_id, action, assigned_by, metadata
      ) VALUES (
        NEW.user_id, NEW.role_id, NEW.facility_id, NEW.tenant_id, 'activated', NEW.assigned_by,
        jsonb_build_object('previous_state', 'inactive', 'new_state', 'active')
      );
    ELSIF OLD.expires_at IS DISTINCT FROM NEW.expires_at OR OLD.metadata IS DISTINCT FROM NEW.metadata THEN
      INSERT INTO public.role_assignments_audit (
        user_id, role_id, facility_id, tenant_id, action, assigned_by, metadata
      ) VALUES (
        NEW.user_id, NEW.role_id, NEW.facility_id, NEW.tenant_id, 'modified', NEW.assigned_by,
        jsonb_build_object(
          'old_expires_at', OLD.expires_at,
          'new_expires_at', NEW.expires_at,
          'old_metadata', OLD.metadata,
          'new_metadata', NEW.metadata
        )
      );
    END IF;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    INSERT INTO public.role_assignments_audit (
      user_id, role_id, facility_id, tenant_id, action, metadata
    ) VALUES (
      OLD.user_id, OLD.role_id, OLD.facility_id, OLD.tenant_id, 'revoked',
      jsonb_build_object('was_active', OLD.is_active, 'expires_at', OLD.expires_at)
    );
    RETURN OLD;
  END IF;
END;
$$;

CREATE TRIGGER audit_user_roles_changes
  AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_role_assignment_changes();

-- 1.9 Enable RLS on new tables (policies will be added in Phase 6)
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_assignments_audit ENABLE ROW LEVEL SECURITY;