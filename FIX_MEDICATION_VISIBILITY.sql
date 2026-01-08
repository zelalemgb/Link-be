-- 1. Add facility_id column if it doesn't exist
ALTER TABLE public.medication_orders 
ADD COLUMN IF NOT EXISTS facility_id UUID REFERENCES public.facilities(id);

-- 2. Backfill facility_id from visits table for existing records
UPDATE public.medication_orders mo
SET facility_id = v.facility_id
FROM public.visits v
WHERE mo.visit_id = v.id
  AND mo.facility_id IS NULL;

-- 3. Enable RLS on medication_orders
ALTER TABLE public.medication_orders ENABLE ROW LEVEL SECURITY;

-- 4. VIEW: Allow Staff to view orders in their facility
DROP POLICY IF EXISTS "Staff can view medication orders" ON public.medication_orders;
CREATE POLICY "Staff can view medication orders"
ON public.medication_orders
FOR SELECT
USING (
  facility_id = (SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid())
  OR 
  -- Fallback logic using visit link (useful if facility_id is somehow missing)
  visit_id IN (
    SELECT id FROM public.visits 
    WHERE facility_id = (SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid())
  )
);

-- 5. INSERT: Allow Staff to create orders
DROP POLICY IF EXISTS "Staff can insert medication orders" ON public.medication_orders;
CREATE POLICY "Staff can insert medication orders"
ON public.medication_orders
FOR INSERT
WITH CHECK (
  auth.uid() IN (SELECT auth_user_id FROM public.users)
);

-- 6. UPDATE: Allow Staff (e.g. Pharmacy/Cashier) to update status
DROP POLICY IF EXISTS "Staff can update medication orders" ON public.medication_orders;
CREATE POLICY "Staff can update medication orders"
ON public.medication_orders
FOR UPDATE
USING (
  facility_id = (SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid())
  OR
  visit_id IN (
    SELECT id FROM public.visits 
    WHERE facility_id = (SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid())
  )
);

-- 7. DELETE: Allow Staff to delete (e.g. draft orders)
DROP POLICY IF EXISTS "Staff can delete medication orders" ON public.medication_orders;
CREATE POLICY "Staff can delete medication orders"
ON public.medication_orders
FOR DELETE
USING (
  facility_id = (SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid())
);

-- Ensure billing items are visible (re-applying just in case)
ALTER TABLE public.billing_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view billing items" ON public.billing_items;
CREATE POLICY "Staff can view billing items"
ON public.billing_items
FOR SELECT
USING (
  tenant_id = (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid())
  OR
  visit_id IN (
    SELECT id FROM public.visits 
    WHERE facility_id = (SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid())
  )
);
