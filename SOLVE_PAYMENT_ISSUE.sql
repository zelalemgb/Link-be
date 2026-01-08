-- ==========================================
-- MANUAL FIX FOR PAYMENTS & BILLING VISIBILITY
-- Run this in your Supabase Dashboard SQL Editor
-- ==========================================

-- 1. Enable RLS on payment_line_items (safety measure)
ALTER TABLE public.payment_line_items ENABLE ROW LEVEL SECURITY;

-- 2. Fix access to billing_items (so Cashier can see what to pay)
-- Note: billing_items has a visit_id column.
DROP POLICY IF EXISTS "Staff can view facility billing items" ON public.billing_items;
DROP POLICY IF EXISTS "Finance can view all billing" ON public.billing_items;

CREATE POLICY "Staff can view facility billing items"
ON public.billing_items
FOR SELECT
USING (
  visit_id IN (
    SELECT id FROM public.visits WHERE facility_id = public.get_user_facility_id()
  )
  OR is_super_admin()
);

-- Allow Cashier/Finance to update items (needed for invalidating/updating status)
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

-- 3. Fix access to payment levels (so Nurse can see paid status)
-- Note: payment_line_items does NOT have visit_id, it links to payments via payment_id.
DROP POLICY IF EXISTS "Staff can view facility payment line items" ON public.payment_line_items;
CREATE POLICY "Staff can view facility payment line items"
ON public.payment_line_items
FOR SELECT
USING (
  payment_id IN (
    SELECT id FROM public.payments 
    WHERE visit_id IN (
      SELECT id FROM public.visits WHERE facility_id = public.get_user_facility_id()
    )
  )
  OR is_super_admin()
);

-- Allow Cashier/Finance to insert/update - backend handles this usually, but good for completeness/safety
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
    payment_id IN (
      SELECT id FROM public.payments 
      WHERE visit_id IN (
        SELECT id FROM public.visits WHERE facility_id = public.get_user_facility_id()
      )
    )
  )
  OR is_super_admin()
);
