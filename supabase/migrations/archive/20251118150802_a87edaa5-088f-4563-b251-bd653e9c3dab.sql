-- Phase 2: Permission Check Functions
-- These functions provide secure, efficient permission checking without triggering recursive RLS

-- 2.1 Core Permission Check Function
-- Checks if a user has a specific permission, considering role assignments, facility scope, and expiration
CREATE OR REPLACE FUNCTION public.has_permission(
  _user_id UUID,
  _permission_name TEXT,
  _facility_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON ur.role_id = rp.role_id
    JOIN public.permissions p ON rp.permission_id = p.id
    WHERE ur.user_id = _user_id
      AND p.name = _permission_name
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
      AND (
        _facility_id IS NULL 
        OR ur.facility_id IS NULL  -- Global role applies to all facilities
        OR ur.facility_id = _facility_id
      )
  );
$$;

COMMENT ON FUNCTION public.has_permission IS 'Check if a user has a specific permission at a given facility scope';

-- 2.2 Get All User Permissions Function
-- Returns complete list of permissions for a user with role context
CREATE OR REPLACE FUNCTION public.get_user_permissions(
  _user_id UUID,
  _facility_id UUID DEFAULT NULL
)
RETURNS TABLE (
  permission_name TEXT,
  resource TEXT,
  action TEXT,
  category TEXT,
  role_name TEXT,
  role_slug TEXT,
  scope_level TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT
    p.name as permission_name,
    p.resource,
    p.action,
    p.category,
    r.name as role_name,
    r.slug as role_slug,
    r.scope_level
  FROM public.user_roles ur
  JOIN public.roles r ON ur.role_id = r.id
  JOIN public.role_permissions rp ON r.id = rp.role_id
  JOIN public.permissions p ON rp.permission_id = p.id
  WHERE ur.user_id = _user_id
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
    AND (
      _facility_id IS NULL 
      OR ur.facility_id IS NULL
      OR ur.facility_id = _facility_id
    )
  ORDER BY p.category, p.resource, p.action;
$$;

COMMENT ON FUNCTION public.get_user_permissions IS 'Get all permissions for a user with role and scope context';

-- 2.3 Check if Current User Has Permission (convenience wrapper using auth.uid())
CREATE OR REPLACE FUNCTION public.current_user_has_permission(
  _permission_name TEXT,
  _facility_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_permission(
    (SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1),
    _permission_name,
    _facility_id
  );
$$;

COMMENT ON FUNCTION public.current_user_has_permission IS 'Check if the authenticated user has a specific permission';

-- 2.4 Check if User is Facility Admin
CREATE OR REPLACE FUNCTION public.is_facility_admin(
  _facility_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON ur.role_id = r.id
    WHERE ur.user_id = (
      SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1
    )
    AND r.slug IN ('admin', 'clinic_admin', 'facility_admin')
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
    AND (
      _facility_id IS NULL
      OR ur.facility_id IS NULL
      OR ur.facility_id = _facility_id
    )
  );
$$;

COMMENT ON FUNCTION public.is_facility_admin IS 'Check if the authenticated user is an admin for a specific facility';

-- 2.5 Check if User Has Any of Multiple Permissions (OR logic)
CREATE OR REPLACE FUNCTION public.has_any_permission(
  _user_id UUID,
  _permission_names TEXT[],
  _facility_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON ur.role_id = rp.role_id
    JOIN public.permissions p ON rp.permission_id = p.id
    WHERE ur.user_id = _user_id
      AND p.name = ANY(_permission_names)
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
      AND (
        _facility_id IS NULL 
        OR ur.facility_id IS NULL
        OR ur.facility_id = _facility_id
      )
  );
$$;

COMMENT ON FUNCTION public.has_any_permission IS 'Check if user has at least one of the specified permissions';

-- 2.6 Check if User Has All of Multiple Permissions (AND logic)
CREATE OR REPLACE FUNCTION public.has_all_permissions(
  _user_id UUID,
  _permission_names TEXT[],
  _facility_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _permission TEXT;
  _required_count INT;
  _granted_count INT;
BEGIN
  _required_count := array_length(_permission_names, 1);
  
  IF _required_count IS NULL OR _required_count = 0 THEN
    RETURN false;
  END IF;
  
  SELECT COUNT(DISTINCT p.name) INTO _granted_count
  FROM public.user_roles ur
  JOIN public.role_permissions rp ON ur.role_id = rp.role_id
  JOIN public.permissions p ON rp.permission_id = p.id
  WHERE ur.user_id = _user_id
    AND p.name = ANY(_permission_names)
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
    AND (
      _facility_id IS NULL 
      OR ur.facility_id IS NULL
      OR ur.facility_id = _facility_id
    );
  
  RETURN _granted_count >= _required_count;
END;
$$;

COMMENT ON FUNCTION public.has_all_permissions IS 'Check if user has all of the specified permissions';

-- 2.7 Get User Roles Function
-- Returns all active roles for a user with facility scope information
CREATE OR REPLACE FUNCTION public.get_user_roles(
  _user_id UUID,
  _facility_id UUID DEFAULT NULL
)
RETURNS TABLE (
  role_id UUID,
  role_name TEXT,
  role_slug TEXT,
  scope_level TEXT,
  facility_id UUID,
  tenant_id UUID,
  assigned_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    r.id as role_id,
    r.name as role_name,
    r.slug as role_slug,
    r.scope_level,
    ur.facility_id,
    ur.tenant_id,
    ur.assigned_at,
    ur.expires_at,
    ur.is_active
  FROM public.user_roles ur
  JOIN public.roles r ON ur.role_id = r.id
  WHERE ur.user_id = _user_id
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
    AND (
      _facility_id IS NULL
      OR ur.facility_id IS NULL
      OR ur.facility_id = _facility_id
    )
  ORDER BY 
    CASE r.scope_level
      WHEN 'global' THEN 1
      WHEN 'tenant' THEN 2
      WHEN 'facility' THEN 3
      WHEN 'department' THEN 4
    END,
    ur.assigned_at DESC;
$$;

COMMENT ON FUNCTION public.get_user_roles IS 'Get all active roles for a user with scope and expiration details';

-- 2.8 Check if User Has Role
CREATE OR REPLACE FUNCTION public.user_has_role(
  _user_id UUID,
  _role_slug TEXT,
  _facility_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON ur.role_id = r.id
    WHERE ur.user_id = _user_id
      AND r.slug = _role_slug
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
      AND (
        _facility_id IS NULL
        OR ur.facility_id IS NULL
        OR ur.facility_id = _facility_id
      )
  );
$$;

COMMENT ON FUNCTION public.user_has_role IS 'Check if user has a specific role by slug';

-- 2.9 Get Permission Categories for User
-- Useful for UI navigation and feature gating
CREATE OR REPLACE FUNCTION public.get_user_permission_categories(
  _user_id UUID,
  _facility_id UUID DEFAULT NULL
)
RETURNS TABLE (
  category TEXT,
  permission_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    p.category,
    COUNT(DISTINCT p.id) as permission_count
  FROM public.user_roles ur
  JOIN public.role_permissions rp ON ur.role_id = rp.role_id
  JOIN public.permissions p ON rp.permission_id = p.id
  WHERE ur.user_id = _user_id
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
    AND (
      _facility_id IS NULL 
      OR ur.facility_id IS NULL
      OR ur.facility_id = _facility_id
    )
  GROUP BY p.category
  ORDER BY p.category;
$$;

COMMENT ON FUNCTION public.get_user_permission_categories IS 'Get permission categories and counts for a user';