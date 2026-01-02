-- Drop old RLS policies that reference the public.users table directly
-- These are causing permission denied errors because they're evaluated alongside new RBAC policies

DROP POLICY IF EXISTS "Admins can manage facility requests" ON staff_registration_requests;

-- Also need to check if there's a SELECT version of this old policy
DROP POLICY IF EXISTS "Admins can view facility requests" ON staff_registration_requests;

-- The new RBAC policies we created earlier are sufficient:
-- "RBAC: Admins can view facility requests" (SELECT)
-- "RBAC: Admins can update facility requests" (UPDATE)
-- "RBAC: Users can create registration requests" (INSERT)
-- "RBAC: Users can view their own requests" (SELECT)