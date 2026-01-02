-- Add RLS policy for clinic admins to delete staff invitations
CREATE POLICY "Clinic admins can delete staff invitations"
ON public.staff_invitations
FOR DELETE
TO authenticated
USING (
  facility_id IN (
    SELECT ur.facility_id 
    FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = (
      SELECT id FROM users WHERE auth_user_id = auth.uid() LIMIT 1
    )
    AND r.slug = 'clinic-admin'
    AND ur.is_active = true
  )
);