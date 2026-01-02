-- Allow cashiers (finance role) to view basic patient information 
-- for patients who have visits in their facility
CREATE POLICY "Cashiers can view patients with visits in their facility"
ON public.patients
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.visits v
    INNER JOIN public.users u ON u.auth_user_id = auth.uid()
    WHERE v.patient_id = patients.id
      AND v.facility_id = u.facility_id
      AND u.user_role = 'finance'
  )
);