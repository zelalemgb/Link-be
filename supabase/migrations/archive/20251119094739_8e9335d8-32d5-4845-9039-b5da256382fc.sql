-- Fix is_super_admin function to use correct role slug 'super-admin' (with hyphen)
-- The roles table has 'super-admin' but function was checking for 'super_admin'

CREATE OR REPLACE FUNCTION public.is_super_admin()
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
    JOIN public.users u ON ur.user_id = u.id
    WHERE u.auth_user_id = auth.uid()
      AND r.slug = 'super-admin'  -- Fixed: changed from 'super_admin' to 'super-admin'
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  )
$$;