-- Allow clinic admins and staff to view users in their facility
DO $$
BEGIN
  -- Enable RLS just in case
  ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN others THEN NULL;
END $$;

-- Create/select policy to allow facility-scoped visibility
DROP POLICY IF EXISTS "Facility-scoped user visibility" ON public.users;
CREATE POLICY "Facility-scoped user visibility"
ON public.users
FOR SELECT
TO authenticated
USING (
  auth.uid() IS NOT NULL AND (
    -- Allow viewing own row
    auth_user_id = auth.uid()
    -- Allow viewing anyone in the same facility (works for admins and staff)
    OR facility_id = public.get_user_facility_id()
    -- Super admins can see all
    OR public.is_super_admin()
  )
);
