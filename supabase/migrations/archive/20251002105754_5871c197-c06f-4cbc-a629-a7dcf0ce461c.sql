-- Update RLS policies for lab orders to include lab technicians
DROP POLICY IF EXISTS "Medical staff can manage lab orders" ON public.lab_orders;

CREATE POLICY "Medical staff can manage lab orders"
ON public.lab_orders
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role IN ('doctor', 'clinical_officer', 'nurse', 'lab_technician')
  )
);

-- Update RLS policies for imaging orders to include imaging staff
DROP POLICY IF EXISTS "Medical staff can manage imaging orders" ON public.imaging_orders;

CREATE POLICY "Medical staff can manage imaging orders"
ON public.imaging_orders
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role IN ('doctor', 'clinical_officer', 'nurse', 'imaging_technician', 'radiologist')
  )
);

-- Update RLS policies for medication orders to include pharmacists
DROP POLICY IF EXISTS "Medical staff can manage medication orders" ON public.medication_orders;

CREATE POLICY "Medical staff can manage medication orders"
ON public.medication_orders
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role IN ('doctor', 'clinical_officer', 'nurse', 'pharmacist')
  )
);