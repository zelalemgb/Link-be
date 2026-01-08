-- Add RLS policy for clinic admins to update staff invitations (needed for resend functionality)
-- Matches the logic used for INSERT/SELECT/DELETE in 20251216* migrations.

CREATE POLICY "Clinic admins can update staff invitations"
ON public.staff_invitations
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    WHERE u.auth_user_id = auth.uid()
    AND r.slug = 'clinic-admin'
    AND ur.facility_id = staff_invitations.facility_id
    AND ur.is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    WHERE u.auth_user_id = auth.uid()
    AND r.slug = 'clinic-admin'
    AND ur.facility_id = staff_invitations.facility_id
    AND ur.is_active = true
  )
);
