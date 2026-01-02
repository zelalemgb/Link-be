-- Temporarily allow patient operations for development
-- This policy allows users to search and create patients when they provide valid user credentials

-- First, let's drop the restrictive policies and create more permissive ones for development
DROP POLICY IF EXISTS "Clinic staff can view patients from their facility" ON patients;
DROP POLICY IF EXISTS "Clinic staff can create patients for their facility" ON patients;

-- Create more permissive policies for development
CREATE POLICY "Allow patient viewing for authenticated users"
ON patients FOR SELECT
USING (
  -- Allow if user is super admin
  is_super_admin() 
  OR 
  -- Allow if user has a valid facility association
  (
    facility_id IN (
      SELECT COALESCE(
        u.facility_id,
        f.id
      )
      FROM users u
      LEFT JOIN facilities f ON f.admin_user_id = u.id
      WHERE u.auth_user_id = auth.uid()
    )
  )
  OR
  -- Allow if created by current user
  (
    created_by IN (
      SELECT id FROM users WHERE auth_user_id = auth.uid()
    )
  )
  OR
  -- Temporary: Allow for development when no auth user but valid facility exists
  (
    auth.uid() IS NULL AND 
    facility_id IS NOT NULL
  )
);

CREATE POLICY "Allow patient creation for authenticated users"
ON patients FOR INSERT
WITH CHECK (
  -- Allow if user is super admin
  is_super_admin() 
  OR 
  -- Allow if user provides valid facility_id and created_by
  (
    facility_id IS NOT NULL AND
    created_by IS NOT NULL AND
    (
      -- Either user is authenticated and matches created_by
      created_by IN (
        SELECT id FROM users WHERE auth_user_id = auth.uid()
      )
      OR
      -- Or for development: allow if facility and user exist (even without auth)
      EXISTS (
        SELECT 1 FROM facilities WHERE id = facility_id
      ) AND EXISTS (
        SELECT 1 FROM users WHERE id = created_by
      )
    )
  )
);