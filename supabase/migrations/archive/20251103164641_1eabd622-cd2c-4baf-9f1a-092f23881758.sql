-- Check if medical staff can create medication orders
-- Update RLS policy to ensure medical staff can insert medication orders

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Medical staff can manage medication orders" ON public.medication_orders;

-- Recreate the policy with proper permissions
CREATE POLICY "Medical staff can manage medication orders"
ON public.medication_orders
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
    AND user_role IN ('doctor', 'clinical_officer', 'nurse', 'pharmacist')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
    AND user_role IN ('doctor', 'clinical_officer', 'nurse', 'pharmacist')
  )
);