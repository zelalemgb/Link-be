-- Add RLS policies for RBAC tables

-- Enable RLS on RBAC tables
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_assignments_audit ENABLE ROW LEVEL SECURITY;

-- Permissions table policies
CREATE POLICY "Everyone can view permissions"
ON public.permissions FOR SELECT
USING (true);

CREATE POLICY "Admins can manage permissions"
ON public.permissions FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = ANY(ARRAY['super_admin'::user_role, 'admin'::user_role])
  )
);

-- Roles table policies
CREATE POLICY "Everyone can view roles"
ON public.roles FOR SELECT
USING (true);

CREATE POLICY "Admins can manage roles"
ON public.roles FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = ANY(ARRAY['super_admin'::user_role, 'admin'::user_role])
  )
);

-- Role permissions mapping policies
CREATE POLICY "Everyone can view role permissions"
ON public.role_permissions FOR SELECT
USING (true);

CREATE POLICY "Admins can manage role permissions"
ON public.role_permissions FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = ANY(ARRAY['super_admin'::user_role, 'admin'::user_role])
  )
);

-- User roles policies
CREATE POLICY "Users can view their own roles"
ON public.user_roles FOR SELECT
USING (
  user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = ANY(ARRAY['super_admin'::user_role, 'admin'::user_role])
  )
);

CREATE POLICY "Admins can manage user roles"
ON public.user_roles FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = ANY(ARRAY['super_admin'::user_role, 'admin'::user_role])
  )
);

-- Role assignments audit policies
CREATE POLICY "Admins can view audit logs"
ON public.role_assignments_audit FOR SELECT
USING (
  tenant_id = get_user_tenant_id()
  AND EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = ANY(ARRAY['super_admin'::user_role, 'admin'::user_role, 'medical_director'::user_role])
  )
);

CREATE POLICY "System can insert audit logs"
ON public.role_assignments_audit FOR INSERT
WITH CHECK (true);