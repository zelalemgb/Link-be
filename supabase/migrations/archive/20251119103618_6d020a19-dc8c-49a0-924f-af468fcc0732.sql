
-- Drop the incorrect RLS policy
DROP POLICY IF EXISTS "RBAC: Admins can view facility requests" ON staff_registration_requests;

-- Create corrected RLS policy with 'clinic-admin' instead of 'admin'
CREATE POLICY "RBAC: Admins can view facility requests" 
ON staff_registration_requests
FOR SELECT
TO public
USING (
  current_user_has_any_role(ARRAY['clinic-admin', 'super-admin', 'hospital_ceo']) 
  AND facility_id IN (SELECT unnest(get_user_facility_ids()))
);

-- Also update the UPDATE policy
DROP POLICY IF EXISTS "RBAC: Admins can update facility requests" ON staff_registration_requests;

CREATE POLICY "RBAC: Admins can update facility requests" 
ON staff_registration_requests
FOR UPDATE
TO public
USING (
  current_user_has_any_role(ARRAY['clinic-admin', 'super-admin', 'hospital_ceo']) 
  AND facility_id IN (SELECT unnest(get_user_facility_ids()))
);
