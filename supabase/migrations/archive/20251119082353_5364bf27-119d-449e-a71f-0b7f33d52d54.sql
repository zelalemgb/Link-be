-- Phase 6.2b: Update RLS policies for orders tables to use RBAC system

-- ============================================================================
-- PATIENT_ORDERS TABLE (has facility_id)
-- ============================================================================
DROP POLICY IF EXISTS "Users can view orders at their facility" ON public.patient_orders;
DROP POLICY IF EXISTS "Clinical staff can create orders" ON public.patient_orders;
DROP POLICY IF EXISTS "Clinical staff can update orders" ON public.patient_orders;
DROP POLICY IF EXISTS "Super admins can manage all orders" ON public.patient_orders;

CREATE POLICY "Users can view orders at their facility"
ON public.patient_orders FOR SELECT
USING (
  public.is_super_admin() OR
  (public.can_access_patient_data() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create orders"
ON public.patient_orders FOR INSERT
WITH CHECK (
  public.can_create_orders() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update orders"
ON public.patient_orders FOR UPDATE
USING (
  public.can_create_orders() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- LAB_ORDERS TABLE (no facility_id, check via visit)
-- ============================================================================
DROP POLICY IF EXISTS "Users can view lab orders at their facility" ON public.lab_orders;
DROP POLICY IF EXISTS "Clinical staff can create lab orders" ON public.lab_orders;
DROP POLICY IF EXISTS "Lab staff can update lab orders" ON public.lab_orders;
DROP POLICY IF EXISTS "Lab staff can view results" ON public.lab_orders;
DROP POLICY IF EXISTS "Super admins can manage all lab orders" ON public.lab_orders;

CREATE POLICY "Users can view lab orders"
ON public.lab_orders FOR SELECT
USING (
  public.is_super_admin() OR
  (
    (public.can_view_lab_results() OR public.can_access_patient_data()) AND
    EXISTS (
      SELECT 1 FROM public.visits v
      WHERE v.id = lab_orders.visit_id
        AND v.facility_id = public.get_user_facility_id()
    )
  )
);

CREATE POLICY "Clinical staff can create lab orders"
ON public.lab_orders FOR INSERT
WITH CHECK (
  public.can_create_orders() AND
  tenant_id = public.get_user_tenant_id() AND
  EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.id = lab_orders.visit_id
      AND v.facility_id = public.get_user_facility_id()
  )
);

CREATE POLICY "Lab staff can update lab orders"
ON public.lab_orders FOR UPDATE
USING (
  public.can_manage_lab_orders() AND
  tenant_id = public.get_user_tenant_id() AND
  EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.id = lab_orders.visit_id
      AND v.facility_id = public.get_user_facility_id()
  )
);

-- ============================================================================
-- IMAGING_ORDERS TABLE (no facility_id, check via visit)
-- ============================================================================
DROP POLICY IF EXISTS "Users can view imaging orders at their facility" ON public.imaging_orders;
DROP POLICY IF EXISTS "Clinical staff can create imaging orders" ON public.imaging_orders;
DROP POLICY IF EXISTS "Imaging staff can update imaging orders" ON public.imaging_orders;
DROP POLICY IF EXISTS "Imaging staff can view results" ON public.imaging_orders;
DROP POLICY IF EXISTS "Super admins can manage all imaging orders" ON public.imaging_orders;

CREATE POLICY "Users can view imaging orders"
ON public.imaging_orders FOR SELECT
USING (
  public.is_super_admin() OR
  (
    (public.can_view_imaging_results() OR public.can_access_patient_data()) AND
    EXISTS (
      SELECT 1 FROM public.visits v
      WHERE v.id = imaging_orders.visit_id
        AND v.facility_id = public.get_user_facility_id()
    )
  )
);

CREATE POLICY "Clinical staff can create imaging orders"
ON public.imaging_orders FOR INSERT
WITH CHECK (
  public.can_create_orders() AND
  tenant_id = public.get_user_tenant_id() AND
  EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.id = imaging_orders.visit_id
      AND v.facility_id = public.get_user_facility_id()
  )
);

CREATE POLICY "Imaging staff can update imaging orders"
ON public.imaging_orders FOR UPDATE
USING (
  public.can_manage_imaging_orders() AND
  tenant_id = public.get_user_tenant_id() AND
  EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.id = imaging_orders.visit_id
      AND v.facility_id = public.get_user_facility_id()
  )
);

-- ============================================================================
-- MEDICATION_ORDERS TABLE (no facility_id, check via visit)
-- ============================================================================
DROP POLICY IF EXISTS "Users can view medication orders at their facility" ON public.medication_orders;
DROP POLICY IF EXISTS "Clinical staff can create medication orders" ON public.medication_orders;
DROP POLICY IF EXISTS "Pharmacy staff can update medication orders" ON public.medication_orders;
DROP POLICY IF EXISTS "Super admins can manage all medication orders" ON public.medication_orders;

CREATE POLICY "Users can view medication orders"
ON public.medication_orders FOR SELECT
USING (
  public.is_super_admin() OR
  (
    (public.can_dispense_medication() OR public.can_access_patient_data()) AND
    EXISTS (
      SELECT 1 FROM public.visits v
      WHERE v.id = medication_orders.visit_id
        AND v.facility_id = public.get_user_facility_id()
    )
  )
);

CREATE POLICY "Clinical staff can create medication orders"
ON public.medication_orders FOR INSERT
WITH CHECK (
  public.can_create_orders() AND
  tenant_id = public.get_user_tenant_id() AND
  EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.id = medication_orders.visit_id
      AND v.facility_id = public.get_user_facility_id()
  )
);

CREATE POLICY "Pharmacy staff can update medication orders"
ON public.medication_orders FOR UPDATE
USING (
  public.can_dispense_medication() AND
  tenant_id = public.get_user_tenant_id() AND
  EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.id = medication_orders.visit_id
      AND v.facility_id = public.get_user_facility_id()
  )
);

-- ============================================================================
-- RX_ITEMS TABLE (uses order_id to link to patient_orders)
-- ============================================================================
DROP POLICY IF EXISTS "Users can view rx items at their facility" ON public.rx_items;
DROP POLICY IF EXISTS "Clinical staff can create rx items" ON public.rx_items;
DROP POLICY IF EXISTS "Pharmacy staff can update rx items" ON public.rx_items;
DROP POLICY IF EXISTS "Super admins can manage all rx items" ON public.rx_items;

CREATE POLICY "Users can view rx items"
ON public.rx_items FOR SELECT
USING (
  public.is_super_admin() OR
  (
    (public.can_dispense_medication() OR public.can_access_patient_data()) AND
    EXISTS (
      SELECT 1 FROM public.patient_orders po
      WHERE po.id = rx_items.order_id
        AND po.facility_id = public.get_user_facility_id()
    )
  )
);

CREATE POLICY "Clinical staff can create rx items"
ON public.rx_items FOR INSERT
WITH CHECK (
  public.can_create_orders() AND
  tenant_id = public.get_user_tenant_id() AND
  EXISTS (
    SELECT 1 FROM public.patient_orders po
    WHERE po.id = rx_items.order_id
      AND po.facility_id = public.get_user_facility_id()
  )
);

CREATE POLICY "Pharmacy staff can update rx items"
ON public.rx_items FOR UPDATE
USING (
  public.can_dispense_medication() AND
  tenant_id = public.get_user_tenant_id() AND
  EXISTS (
    SELECT 1 FROM public.patient_orders po
    WHERE po.id = rx_items.order_id
      AND po.facility_id = public.get_user_facility_id()
  )
);