-- Drop the existing restrictive policy
DROP POLICY IF EXISTS "Pharmacists can create stock requests" ON public.stock_requests;

-- Create a more permissive policy for authenticated users with proper roles
CREATE POLICY "Medical staff can create stock requests"
  ON public.stock_requests
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.auth_user_id = auth.uid()
      AND users.user_role = ANY(ARRAY['pharmacist'::user_role, 'nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
      AND (users.facility_id = stock_requests.facility_id OR stock_requests.facility_id IS NULL)
    )
  );