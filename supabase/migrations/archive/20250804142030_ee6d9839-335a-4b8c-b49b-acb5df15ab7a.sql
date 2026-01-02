-- Update visits table policies to match patient policies for development
DROP POLICY IF EXISTS "Clinic staff can view visits from their facility" ON visits;
DROP POLICY IF EXISTS "Clinic staff can create visits for their facility" ON visits;

-- Create more permissive policies for visits
CREATE POLICY "Allow visit viewing for authenticated users"
ON visits FOR SELECT
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

CREATE POLICY "Allow visit creation for authenticated users"
ON visits FOR INSERT
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