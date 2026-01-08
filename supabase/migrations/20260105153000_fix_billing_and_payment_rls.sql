-- Enable RLS on payment_line_items (if not already)
ALTER TABLE public.payment_line_items ENABLE ROW LEVEL SECURITY;

-- 1. Policies for billing_items

-- Allow staff to view billing items for their facility (via visit)
DROP POLICY IF EXISTS "Staff can view facility billing items" ON public.billing_items;
CREATE POLICY "Staff can view facility billing items"
ON public.billing_items
FOR SELECT
USING (
  visit_id IN (
    SELECT id FROM public.visits WHERE facility_id = public.get_user_facility_id()
  )
  OR is_super_admin()
);

-- Allow staff to update billing items (e.g. invalidating) if needed, or strictly cashier/finance
DROP POLICY IF EXISTS "Cashier and Finance can update billing items" ON public.billing_items;
CREATE POLICY "Cashier and Finance can update billing items"
ON public.billing_items
FOR UPDATE
USING (
  (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('cashier', 'finance', 'hospital_ceo', 'medical_director')
    )
    AND
    visit_id IN (
      SELECT id FROM public.visits WHERE facility_id = public.get_user_facility_id()
    )
  )
  OR is_super_admin()
);

-- 2. Policies for payment_line_items

-- Allow staff (Nurse, Cashier, Doctor) to view payment line items for their facility
DROP POLICY IF EXISTS "Staff can view facility payment line items" ON public.payment_line_items;
CREATE POLICY "Staff can view facility payment line items"
ON public.payment_line_items
FOR SELECT
USING (
  visit_id IN (
    SELECT id FROM public.visits WHERE facility_id = public.get_user_facility_id()
  )
  OR is_super_admin()
);

-- Allow Cashier/Finance to insert/update payment line items (if frontend ever needs to, though backend handles it)
DROP POLICY IF EXISTS "Cashier and Finance can manage payment line items" ON public.payment_line_items;
CREATE POLICY "Cashier and Finance can manage payment line items"
ON public.payment_line_items
FOR ALL
USING (
  (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('cashier', 'finance')
    )
    AND
    visit_id IN (
      SELECT id FROM public.visits WHERE facility_id = public.get_user_facility_id()
    )
  )
  OR is_super_admin()
);
