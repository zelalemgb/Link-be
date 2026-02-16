-- Inventory tenant consistency + high-frequency query index hardening.

-- Align stock movement tenant IDs with their inventory items where possible.
UPDATE public.stock_movements sm
SET tenant_id = ii.tenant_id
FROM public.inventory_items ii
WHERE sm.inventory_item_id = ii.id
  AND sm.tenant_id IS DISTINCT FROM ii.tenant_id;

-- Fallback alignment from facility when item-based alignment is unavailable.
UPDATE public.stock_movements sm
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE sm.facility_id = f.id
  AND sm.tenant_id IS NULL;

-- Composite uniqueness required for tenant-consistent foreign keys.
ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_id_tenant_unique;
ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_id_tenant_unique UNIQUE (id, tenant_id);

ALTER TABLE public.facilities
  DROP CONSTRAINT IF EXISTS facilities_id_tenant_unique;
ALTER TABLE public.facilities
  ADD CONSTRAINT facilities_id_tenant_unique UNIQUE (id, tenant_id);

-- Enforce tenant-consistent parent linkage on new writes.
ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_inventory_item_tenant_fkey;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_inventory_item_tenant_fkey
  FOREIGN KEY (inventory_item_id, tenant_id)
  REFERENCES public.inventory_items(id, tenant_id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_facility_tenant_fkey;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_facility_tenant_fkey
  FOREIGN KEY (facility_id, tenant_id)
  REFERENCES public.facilities(id, tenant_id)
  ON DELETE RESTRICT
  NOT VALID;

-- Targeted indexes for high-frequency inventory reads.
CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant_facility_active_name
  ON public.inventory_items(tenant_id, facility_id, is_active, name);

CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_facility_created_at
  ON public.stock_movements(tenant_id, facility_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_item_facility_created_at
  ON public.stock_movements(inventory_item_id, facility_id, created_at DESC);

-- Explicit WITH CHECK on mutable stock movement operations.
DROP POLICY IF EXISTS "Logistic officers and pharmacists can create movements" ON public.stock_movements;
CREATE POLICY "Logistic officers and pharmacists can create movements" ON public.stock_movements
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Logistic officers can update movements" ON public.stock_movements;
CREATE POLICY "Logistic officers can update movements" ON public.stock_movements
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'super_admin')
    )
  )
  WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'super_admin')
    )
  );
