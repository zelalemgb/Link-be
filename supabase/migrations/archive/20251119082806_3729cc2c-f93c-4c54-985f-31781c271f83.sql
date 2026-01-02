-- Phase 6.2d: Update RLS policies for master data tables to use RBAC (fixed)

-- ============================================================================
-- MEDICAL_SERVICES TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage medical services" ON public.medical_services;
DROP POLICY IF EXISTS "Staff can view medical services" ON public.medical_services;
DROP POLICY IF EXISTS "Users can view medical services at their facility" ON public.medical_services;
DROP POLICY IF EXISTS "Super admins can manage all medical services" ON public.medical_services;
DROP POLICY IF EXISTS "Facility staff can view services" ON public.medical_services;

-- Create new RBAC-based policies for medical_services
CREATE POLICY "RBAC: Staff can view medical services"
  ON public.medical_services
  FOR SELECT
  USING (
    facility_id IN (SELECT unnest(get_user_facility_ids()))
    OR is_super_admin()
  );

CREATE POLICY "RBAC: Admins can manage medical services"
  ON public.medical_services
  FOR ALL
  USING (
    can_manage_master_data()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

-- ============================================================================
-- INVENTORY_ITEMS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage inventory items" ON public.inventory_items;
DROP POLICY IF EXISTS "Facility staff can view inventory items" ON public.inventory_items;
DROP POLICY IF EXISTS "Logistic officers can manage inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Pharmacists can view inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Super admins can manage all inventory" ON public.inventory_items;

-- Create new RBAC-based policies for inventory_items
CREATE POLICY "RBAC: Staff can view inventory items"
  ON public.inventory_items
  FOR SELECT
  USING (
    facility_id IN (SELECT unnest(get_user_facility_ids()))
    OR is_super_admin()
  );

CREATE POLICY "RBAC: Inventory managers can manage items"
  ON public.inventory_items
  FOR ALL
  USING (
    (can_manage_inventory() OR can_manage_master_data())
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

-- ============================================================================
-- SUPPLIERS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Facility staff can view suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Logistic officers can manage suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Super admins can manage all suppliers" ON public.suppliers;

-- Create new RBAC-based policies for suppliers
CREATE POLICY "RBAC: Staff can view suppliers"
  ON public.suppliers
  FOR SELECT
  USING (
    (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
    AND (tenant_id = get_user_tenant_id() OR is_super_admin())
  );

CREATE POLICY "RBAC: Admins can manage suppliers"
  ON public.suppliers
  FOR ALL
  USING (
    (can_manage_inventory() OR can_manage_master_data() OR current_user_has_any_role(ARRAY['admin', 'super_admin']))
    AND (tenant_id = get_user_tenant_id())
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
  );

-- ============================================================================
-- PROGRAMS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can delete programs" ON public.programs;
DROP POLICY IF EXISTS "Admins can insert programs" ON public.programs;
DROP POLICY IF EXISTS "Admins can update programs" ON public.programs;
DROP POLICY IF EXISTS "Users can view programs for their tenant" ON public.programs;

-- Create new RBAC-based policies for programs
CREATE POLICY "RBAC: Staff can view programs"
  ON public.programs
  FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
  );

CREATE POLICY "RBAC: Admins can manage programs"
  ON public.programs
  FOR ALL
  USING (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin', 'super_admin']))
    AND tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
  );

-- ============================================================================
-- CREDITORS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can delete creditors" ON public.creditors;
DROP POLICY IF EXISTS "Admins can insert creditors" ON public.creditors;
DROP POLICY IF EXISTS "Admins can update creditors" ON public.creditors;
DROP POLICY IF EXISTS "Users can view creditors for their tenant" ON public.creditors;

-- Create new RBAC-based policies for creditors
CREATE POLICY "RBAC: Staff can view creditors"
  ON public.creditors
  FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
  );

CREATE POLICY "RBAC: Admins can manage creditors"
  ON public.creditors
  FOR ALL
  USING (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin', 'super_admin']))
    AND tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
  );

-- ============================================================================
-- INSURERS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can delete insurers" ON public.insurers;
DROP POLICY IF EXISTS "Admins can insert insurers" ON public.insurers;
DROP POLICY IF EXISTS "Admins can update insurers" ON public.insurers;
DROP POLICY IF EXISTS "Users can view insurers for their tenant" ON public.insurers;

-- Create new RBAC-based policies for insurers
CREATE POLICY "RBAC: Staff can view insurers"
  ON public.insurers
  FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
  );

CREATE POLICY "RBAC: Admins can manage insurers"
  ON public.insurers
  FOR ALL
  USING (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin', 'super_admin']))
    AND tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
  );

-- ============================================================================
-- DEPARTMENTS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admin can manage departments" ON public.departments;
DROP POLICY IF EXISTS "Facility staff can view departments" ON public.departments;

-- Create new RBAC-based policies for departments
CREATE POLICY "RBAC: Staff can view departments"
  ON public.departments
  FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

CREATE POLICY "RBAC: Admins can manage departments"
  ON public.departments
  FOR ALL
  USING (
    (current_user_has_any_role(ARRAY['admin', 'super_admin', 'hospital_ceo', 'medical_director', 'nursing_head']) OR can_manage_master_data())
    AND tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

-- ============================================================================
-- WARDS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admin can manage wards" ON public.wards;
DROP POLICY IF EXISTS "Facility staff can view wards" ON public.wards;

-- Create new RBAC-based policies for wards
CREATE POLICY "RBAC: Staff can view wards"
  ON public.wards
  FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

CREATE POLICY "RBAC: Admins can manage wards"
  ON public.wards
  FOR ALL
  USING (
    current_user_has_any_role(ARRAY['nursing_head', 'admin', 'super_admin', 'hospital_ceo', 'medical_director'])
    AND tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

-- ============================================================================
-- BEDS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admin can manage beds" ON public.beds;
DROP POLICY IF EXISTS "Facility staff can view beds" ON public.beds;
DROP POLICY IF EXISTS "Nurses can update beds" ON public.beds;

-- Create new RBAC-based policies for beds
CREATE POLICY "RBAC: Staff can view beds"
  ON public.beds
  FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

CREATE POLICY "RBAC: Admins can manage beds"
  ON public.beds
  FOR ALL
  USING (
    current_user_has_any_role(ARRAY['nursing_head', 'admin', 'super_admin', 'hospital_ceo'])
    AND tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

CREATE POLICY "RBAC: Nurses can update beds"
  ON public.beds
  FOR UPDATE
  USING (
    current_user_has_any_role(ARRAY['nurse', 'nursing_head', 'doctor', 'admin', 'super_admin'])
    AND tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

-- ============================================================================
-- DISPENSING_UNITS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Facility staff can view their units" ON public.dispensing_units;
DROP POLICY IF EXISTS "Logistic officers can manage units" ON public.dispensing_units;

-- Create new RBAC-based policies for dispensing_units
CREATE POLICY "RBAC: Staff can view dispensing units"
  ON public.dispensing_units
  FOR SELECT
  USING (
    facility_id IN (SELECT unnest(get_user_facility_ids()))
    OR is_super_admin()
  );

CREATE POLICY "RBAC: Inventory managers can manage dispensing units"
  ON public.dispensing_units
  FOR ALL
  USING (
    (can_manage_inventory() OR can_manage_master_data() OR current_user_has_any_role(ARRAY['admin', 'super_admin']))
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );