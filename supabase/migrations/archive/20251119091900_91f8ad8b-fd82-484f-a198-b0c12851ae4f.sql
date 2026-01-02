-- Update useUserPermissions to handle super admin without facility requirement
-- First, let's ensure super admin role assignment doesn't require facility_id

-- Update the super admin user_role assignment to remove facility requirement
UPDATE public.user_roles
SET facility_id = NULL
WHERE role_id = (SELECT id FROM public.roles WHERE slug = 'super-admin' LIMIT 1)
  AND user_id IN (
    SELECT id FROM public.users WHERE user_role = 'super_admin'
  );

-- Create a function to check if user is super admin by auth_user_id
CREATE OR REPLACE FUNCTION public.is_user_super_admin(p_auth_user_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.auth_user_id = COALESCE(p_auth_user_id, auth.uid())
      AND r.slug = 'super-admin'
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  )
$$;

-- Update RLS policy on user_roles to allow super admins to view all roles
DROP POLICY IF EXISTS "RBAC: Super admins can view all roles" ON public.user_roles;
CREATE POLICY "RBAC: Super admins can view all roles"
ON public.user_roles
FOR SELECT
TO public
USING (
  is_user_super_admin(auth.uid())
);

-- Ensure super admins can view all users
DROP POLICY IF EXISTS "Super admins can view all users" ON public.users;
CREATE POLICY "Super admins can view all users"
ON public.users
FOR SELECT
TO public
USING (
  is_user_super_admin(auth.uid())
);