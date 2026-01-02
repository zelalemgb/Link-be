-- Add RLS policy to allow clinic admins to insert staff invitations for their facility
CREATE POLICY "Clinic admins can insert staff invitations for their facility"
ON public.staff_invitations
FOR INSERT
TO authenticated
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

-- Also allow clinic admins to view their facility's invitations
CREATE POLICY "Clinic admins can view staff invitations for their facility"
ON public.staff_invitations
FOR SELECT
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
);