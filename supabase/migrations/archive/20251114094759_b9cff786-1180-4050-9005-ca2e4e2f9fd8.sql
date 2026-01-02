-- Add UPDATE policy for staff_invitations so admins can resend invitations
CREATE POLICY "Facility admin can update their invitations"
ON staff_invitations
FOR UPDATE
TO authenticated
USING (
  facility_id IN (
    SELECT id 
    FROM facilities 
    WHERE admin_user_id = auth.uid()
  )
)
WITH CHECK (
  facility_id IN (
    SELECT id 
    FROM facilities 
    WHERE admin_user_id = auth.uid()
  )
);