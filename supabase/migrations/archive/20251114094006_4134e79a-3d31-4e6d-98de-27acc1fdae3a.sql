-- Fix the RLS policy for staff_invitations
-- Drop the existing incorrect policy
DROP POLICY IF EXISTS "Facility admin can create invitations" ON staff_invitations;

-- Create the corrected policy that directly checks admin_user_id
CREATE POLICY "Facility admin can create invitations"
ON staff_invitations
FOR INSERT
TO authenticated
WITH CHECK (
  facility_id IN (
    SELECT id 
    FROM facilities 
    WHERE admin_user_id = auth.uid()
  )
);