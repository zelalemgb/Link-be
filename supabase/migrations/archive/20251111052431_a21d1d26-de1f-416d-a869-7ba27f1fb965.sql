-- Allow finance staff (cashiers) to insert and update payment records
CREATE POLICY "Finance staff can insert payments"
ON public.payments
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = 'finance'
      AND u.facility_id = payments.facility_id
  )
);

CREATE POLICY "Finance staff can update payments"
ON public.payments
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = 'finance'
      AND u.facility_id = payments.facility_id
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = 'finance'
      AND u.facility_id = payments.facility_id
  )
);

CREATE POLICY "Finance staff can view payments"
ON public.payments
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = 'finance'
      AND u.facility_id = payments.facility_id
  )
);