
-- Drop existing incomplete policies
DROP POLICY IF EXISTS "Facility staff can view stock movements" ON public.stock_movements;
DROP POLICY IF EXISTS "Logistic officers and pharmacists can create movements" ON public.stock_movements;
DROP POLICY IF EXISTS "Logistic officers can update movements" ON public.stock_movements;
DROP POLICY IF EXISTS "Super admins can delete stock movements" ON public.stock_movements;

-- Add tenant_id column to stock_movements table
ALTER TABLE public.stock_movements 
ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL 
REFERENCES public.tenants(id) ON DELETE CASCADE
DEFAULT '00000000-0000-0000-0000-000000000001';

-- Remove the default after adding the column
ALTER TABLE public.stock_movements 
ALTER COLUMN tenant_id DROP DEFAULT;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_id 
ON public.stock_movements(tenant_id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_facility 
ON public.stock_movements(tenant_id, facility_id);

-- Policy: Facility staff can view stock movements in their tenant and facility
CREATE POLICY "Facility staff can view stock movements"
ON public.stock_movements
FOR SELECT
TO authenticated
USING (
  tenant_id = get_user_tenant_id() 
  AND (facility_id = get_user_facility_id() OR is_super_admin())
);

-- Policy: Logistic officers and pharmacists can create stock movements
CREATE POLICY "Logistic officers can create stock movements"
ON public.stock_movements
FOR INSERT
TO authenticated
WITH CHECK (
  tenant_id = get_user_tenant_id()
  AND facility_id = get_user_facility_id()
  AND EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role IN ('logistic_officer', 'pharmacist', 'super_admin')
  )
);

-- Policy: Logistic officers can update stock movements
CREATE POLICY "Logistic officers can update stock movements"
ON public.stock_movements
FOR UPDATE
TO authenticated
USING (
  tenant_id = get_user_tenant_id()
  AND facility_id = get_user_facility_id()
  AND EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role IN ('logistic_officer', 'pharmacist', 'super_admin')
  )
);

-- Policy: Super admins can delete stock movements (for corrections)
CREATE POLICY "Super admins can delete stock movements"
ON public.stock_movements
FOR DELETE
TO authenticated
USING (
  is_super_admin()
);

-- Add documentation
COMMENT ON COLUMN stock_movements.tenant_id IS 'Tenant isolation - ensures stock movements are scoped to specific tenant organization';
COMMENT ON TABLE stock_movements IS 'Stock movements with RLS policies enforcing tenant-level isolation for inventory operations';
