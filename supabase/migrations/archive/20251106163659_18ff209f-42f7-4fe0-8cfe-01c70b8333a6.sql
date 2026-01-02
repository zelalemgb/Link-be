-- Phase 6: Data Migration & Testing

-- Step 1: Add tenant_id to remaining tables that don't have it yet

-- Add tenant_id to inventory tables
ALTER TABLE public.inventory_items ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.inventory_items SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = inventory_items.facility_id) WHERE tenant_id IS NULL;
UPDATE public.inventory_items SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.inventory_items ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.suppliers SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = suppliers.facility_id) WHERE tenant_id IS NULL;
UPDATE public.suppliers SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.suppliers ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.receiving_invoices ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.receiving_invoices SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = receiving_invoices.facility_id) WHERE tenant_id IS NULL;
UPDATE public.receiving_invoices SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.receiving_invoices ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.receiving_invoice_items ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.receiving_invoice_items SET tenant_id = (SELECT tenant_id FROM public.receiving_invoices WHERE id = receiving_invoice_items.invoice_id) WHERE tenant_id IS NULL;
UPDATE public.receiving_invoice_items SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.receiving_invoice_items ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.loss_adjustments ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.loss_adjustments SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = loss_adjustments.facility_id) WHERE tenant_id IS NULL;
UPDATE public.loss_adjustments SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.loss_adjustments ALTER COLUMN tenant_id SET NOT NULL;

-- Add tenant_id to service and master data tables
ALTER TABLE public.medical_services ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.medical_services SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = medical_services.facility_id) WHERE tenant_id IS NULL;
UPDATE public.medical_services SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.medical_services ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.medication_master ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.medication_master SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.medication_master ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.lab_test_master ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.lab_test_master SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.lab_test_master ALTER COLUMN tenant_id SET NOT NULL;

-- Add tenant_id to specialized visit tables
ALTER TABLE public.delivery_records ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.delivery_records SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = delivery_records.facility_id) WHERE tenant_id IS NULL;
UPDATE public.delivery_records SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.delivery_records ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.family_planning_visits ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.family_planning_visits SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = family_planning_visits.facility_id) WHERE tenant_id IS NULL;
UPDATE public.family_planning_visits SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.family_planning_visits ALTER COLUMN tenant_id SET NOT NULL;

-- Add tenant_id to patient portal tables
ALTER TABLE public.patient_accounts ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.patient_accounts SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.patient_accounts ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.patient_appointment_requests ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.patient_appointment_requests SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = patient_appointment_requests.facility_id) WHERE tenant_id IS NULL;
UPDATE public.patient_appointment_requests SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.patient_appointment_requests ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.patient_documents ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.patient_documents SET tenant_id = (SELECT tenant_id FROM public.patient_accounts WHERE id = patient_documents.patient_account_id) WHERE tenant_id IS NULL;
UPDATE public.patient_documents SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.patient_documents ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.patient_symptom_logs ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.patient_symptom_logs SET tenant_id = (SELECT tenant_id FROM public.patient_accounts WHERE id = patient_symptom_logs.patient_account_id) WHERE tenant_id IS NULL;
UPDATE public.patient_symptom_logs SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.patient_symptom_logs ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.patient_visit_summaries ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.patient_visit_summaries SET tenant_id = (SELECT tenant_id FROM public.patient_accounts WHERE id = patient_visit_summaries.patient_account_id) WHERE tenant_id IS NULL;
UPDATE public.patient_visit_summaries SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.patient_visit_summaries ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.patient_notifications ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.patient_notifications SET tenant_id = (SELECT tenant_id FROM public.patients WHERE id = patient_notifications.patient_id) WHERE tenant_id IS NULL;
UPDATE public.patient_notifications SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.patient_notifications ALTER COLUMN tenant_id SET NOT NULL;

-- Add tenant_id to system tables
ALTER TABLE public.staff_invitations ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.staff_invitations SET tenant_id = (SELECT tenant_id FROM public.facilities WHERE id = staff_invitations.facility_id) WHERE tenant_id IS NULL;
UPDATE public.staff_invitations SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.staff_invitations ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.payment_transactions ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.payment_transactions SET tenant_id = (SELECT tenant_id FROM public.payments WHERE id = payment_transactions.payment_id) WHERE tenant_id IS NULL;
UPDATE public.payment_transactions SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.payment_transactions ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.imaging_order_templates ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.imaging_order_templates SET tenant_id = (SELECT tenant_id FROM public.users WHERE id = imaging_order_templates.created_by) WHERE tenant_id IS NULL;
UPDATE public.imaging_order_templates SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.imaging_order_templates ALTER COLUMN tenant_id SET NOT NULL;

-- Step 2: Create indexes on new tenant_id columns for performance
CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant_id ON public.inventory_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_id ON public.suppliers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_receiving_invoices_tenant_id ON public.receiving_invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_receiving_invoice_items_tenant_id ON public.receiving_invoice_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_loss_adjustments_tenant_id ON public.loss_adjustments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_medical_services_tenant_id ON public.medical_services(tenant_id);
CREATE INDEX IF NOT EXISTS idx_medication_master_tenant_id ON public.medication_master(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lab_test_master_tenant_id ON public.lab_test_master(tenant_id);
CREATE INDEX IF NOT EXISTS idx_delivery_records_tenant_id ON public.delivery_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_family_planning_visits_tenant_id ON public.family_planning_visits(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_accounts_tenant_id ON public.patient_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_appointment_requests_tenant_id ON public.patient_appointment_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_documents_tenant_id ON public.patient_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_symptom_logs_tenant_id ON public.patient_symptom_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_visit_summaries_tenant_id ON public.patient_visit_summaries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_notifications_tenant_id ON public.patient_notifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_staff_invitations_tenant_id ON public.staff_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_tenant_id ON public.payment_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_imaging_order_templates_tenant_id ON public.imaging_order_templates(tenant_id);

-- Step 3: Create backward compatibility views for legacy order queries
CREATE OR REPLACE VIEW public.v_lab_orders_with_patient AS
SELECT 
  lo.*,
  p.full_name as patient_full_name,
  p.age as patient_age,
  p.gender as patient_gender,
  ltm.sample_type
FROM public.lab_orders lo
JOIN public.patients p ON p.id = lo.patient_id
LEFT JOIN public.lab_test_master ltm ON ltm.test_code = lo.test_code;

CREATE OR REPLACE VIEW public.v_imaging_orders_with_patient AS
SELECT 
  io.*,
  p.full_name as patient_full_name,
  p.age as patient_age,
  p.gender as patient_gender
FROM public.imaging_orders io
JOIN public.patients p ON p.id = io.patient_id;

CREATE OR REPLACE VIEW public.v_medication_orders_with_patient AS
SELECT 
  mo.*,
  p.full_name as patient_full_name,
  p.age as patient_age,
  p.gender as patient_gender,
  u.name as prescriber_name
FROM public.medication_orders mo
JOIN public.patients p ON p.id = mo.patient_id
LEFT JOIN public.users u ON u.id = mo.ordered_by;

-- Step 4: Create unified order view from normalized structure
CREATE OR REPLACE VIEW public.v_unified_orders AS
SELECT 
  po.id,
  po.tenant_id,
  po.visit_id,
  po.patient_id,
  po.facility_id,
  po.ordered_by,
  po.order_type,
  po.status,
  po.urgency,
  po.ordered_at,
  po.completed_at,
  po.clinical_notes,
  po.payment_status,
  po.total_amount,
  p.full_name as patient_name,
  p.age as patient_age,
  p.gender as patient_gender,
  u.name as ordered_by_name,
  f.name as facility_name,
  COALESCE(
    (SELECT json_agg(json_build_object(
      'item_name', item_name,
      'item_code', item_code,
      'status', status,
      'result_text', result_text
    ))
    FROM public.patient_order_items 
    WHERE order_id = po.id),
    '[]'::json
  ) as order_items,
  COALESCE(
    (SELECT json_agg(json_build_object(
      'medication_name', medication_name,
      'dosage', dosage,
      'frequency', frequency,
      'status', status
    ))
    FROM public.rx_items 
    WHERE order_id = po.id),
    '[]'::json
  ) as rx_items
FROM public.patient_orders po
JOIN public.patients p ON p.id = po.patient_id
JOIN public.facilities f ON f.id = po.facility_id
LEFT JOIN public.users u ON u.id = po.ordered_by;

-- Step 5: Create data validation functions

-- Function to validate tenant isolation
CREATE OR REPLACE FUNCTION public.validate_tenant_isolation()
RETURNS TABLE(
  table_name TEXT,
  total_records BIGINT,
  records_with_tenant_id BIGINT,
  records_without_tenant_id BIGINT,
  unique_tenants BIGINT,
  is_valid BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH tenant_checks AS (
    SELECT 'facilities' as tbl, COUNT(*) as total, COUNT(tenant_id) as with_tenant FROM facilities
    UNION ALL
    SELECT 'users', COUNT(*), COUNT(tenant_id) FROM users
    UNION ALL
    SELECT 'patients', COUNT(*), COUNT(tenant_id) FROM patients
    UNION ALL
    SELECT 'visits', COUNT(*), COUNT(tenant_id) FROM visits
    UNION ALL
    SELECT 'patient_orders', COUNT(*), COUNT(tenant_id) FROM patient_orders
    UNION ALL
    SELECT 'admissions', COUNT(*), COUNT(tenant_id) FROM admissions
    UNION ALL
    SELECT 'departments', COUNT(*), COUNT(tenant_id) FROM departments
  )
  SELECT 
    tc.tbl::TEXT,
    tc.total::BIGINT,
    tc.with_tenant::BIGINT,
    (tc.total - tc.with_tenant)::BIGINT as without_tenant,
    0::BIGINT as unique_tenants,
    (tc.total = tc.with_tenant) as is_valid
  FROM tenant_checks tc;
END;
$$;

-- Function to validate data migration completeness
CREATE OR REPLACE FUNCTION public.validate_order_migration()
RETURNS TABLE(
  check_name TEXT,
  expected_count BIGINT,
  actual_count BIGINT,
  is_valid BOOLEAN,
  notes TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  -- Check lab orders migration
  SELECT 
    'Lab Orders Migration'::TEXT,
    (SELECT COUNT(*) FROM lab_orders)::BIGINT,
    (SELECT COUNT(*) FROM patient_orders WHERE order_type = 'lab')::BIGINT,
    (SELECT COUNT(*) FROM lab_orders) = (SELECT COUNT(*) FROM patient_orders WHERE order_type = 'lab'),
    'Verify all lab orders were migrated to patient_orders'::TEXT
  
  UNION ALL
  
  -- Check imaging orders migration
  SELECT 
    'Imaging Orders Migration'::TEXT,
    (SELECT COUNT(*) FROM imaging_orders)::BIGINT,
    (SELECT COUNT(*) FROM patient_orders WHERE order_type = 'imaging')::BIGINT,
    (SELECT COUNT(*) FROM imaging_orders) = (SELECT COUNT(*) FROM patient_orders WHERE order_type = 'imaging'),
    'Verify all imaging orders were migrated to patient_orders'::TEXT
  
  UNION ALL
  
  -- Check medication orders migration
  SELECT 
    'Medication Orders Migration'::TEXT,
    (SELECT COUNT(*) FROM medication_orders)::BIGINT,
    (SELECT COUNT(*) FROM patient_orders WHERE order_type = 'medication')::BIGINT,
    (SELECT COUNT(*) FROM medication_orders) = (SELECT COUNT(*) FROM patient_orders WHERE order_type = 'medication'),
    'Verify all medication orders were migrated to patient_orders'::TEXT
  
  UNION ALL
  
  -- Check rx_items migration
  SELECT 
    'Rx Items Migration'::TEXT,
    (SELECT COUNT(*) FROM medication_orders)::BIGINT,
    (SELECT COUNT(*) FROM rx_items)::BIGINT,
    (SELECT COUNT(*) FROM medication_orders) = (SELECT COUNT(*) FROM rx_items),
    'Verify all medication orders have corresponding rx_items'::TEXT;
END;
$$;

-- Function to check RLS policy coverage
CREATE OR REPLACE FUNCTION public.check_rls_coverage()
RETURNS TABLE(
  table_name TEXT,
  rls_enabled BOOLEAN,
  policy_count BIGINT,
  has_select_policy BOOLEAN,
  has_insert_policy BOOLEAN,
  has_update_policy BOOLEAN,
  has_delete_policy BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    c.relname::TEXT as table_name,
    c.relrowsecurity as rls_enabled,
    COUNT(p.polname)::BIGINT as policy_count,
    COUNT(p.polname) FILTER (WHERE p.polcmd = 'r')::BIGINT > 0 as has_select,
    COUNT(p.polname) FILTER (WHERE p.polcmd = 'a')::BIGINT > 0 as has_insert,
    COUNT(p.polname) FILTER (WHERE p.polcmd = 'w')::BIGINT > 0 as has_update,
    COUNT(p.polname) FILTER (WHERE p.polcmd = 'd')::BIGINT > 0 as has_delete
  FROM pg_class c
  LEFT JOIN pg_policy p ON p.polrelid = c.oid
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relkind = 'r'
    AND c.relname NOT LIKE 'pg_%'
  GROUP BY c.relname, c.relrowsecurity
  ORDER BY c.relname;
END;
$$;

-- Step 6: Create helper function to get user's tenant facilities
CREATE OR REPLACE FUNCTION public.get_user_tenant_facilities()
RETURNS SETOF UUID
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.facilities 
  WHERE tenant_id = get_user_tenant_id();
$$;

-- Step 7: Update existing RLS policies to enforce tenant isolation where missing

-- Update inventory_items policies
DROP POLICY IF EXISTS "Facility staff can view inventory items" ON public.inventory_items;
CREATE POLICY "Facility staff can view inventory items" ON public.inventory_items
  FOR SELECT USING (
    tenant_id = get_user_tenant_id() 
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers can manage inventory items" ON public.inventory_items;
CREATE POLICY "Logistic officers can manage inventory items" ON public.inventory_items
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('logistic_officer', 'pharmacist', 'super_admin')
    )
  );

-- Update suppliers policies
DROP POLICY IF EXISTS "Facility staff can view their suppliers" ON public.suppliers;
CREATE POLICY "Facility staff can view their suppliers" ON public.suppliers
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers can manage suppliers" ON public.suppliers;
CREATE POLICY "Logistic officers can manage suppliers" ON public.suppliers
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

-- Update patient_accounts policies to enforce tenant
DROP POLICY IF EXISTS "Patients can view their own account" ON public.patient_accounts;
CREATE POLICY "Patients can view their own account" ON public.patient_accounts
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND phone_number = ((current_setting('request.jwt.claims'::text, true))::json ->> 'phone'::text)
  );

-- Step 8: Create summary view for architecture validation
CREATE OR REPLACE VIEW public.v_architecture_summary AS
SELECT 
  'Total Tenants' as metric,
  COUNT(*)::TEXT as value,
  'Core multi-tenancy' as category
FROM tenants
UNION ALL
SELECT 'Total Facilities', COUNT(*)::TEXT, 'Core multi-tenancy' FROM facilities
UNION ALL
SELECT 'Total Users', COUNT(*)::TEXT, 'Identity & Access' FROM users
UNION ALL
SELECT 'Total Patients', COUNT(*)::TEXT, 'Core Clinical' FROM patients
UNION ALL
SELECT 'Total Visits (OPD)', COUNT(*)::TEXT, 'Core Clinical' FROM visits
UNION ALL
SELECT 'Total Admissions (IPD)', COUNT(*)::TEXT, 'Inpatient Management' FROM admissions
UNION ALL
SELECT 'Total Patient Orders', COUNT(*)::TEXT, 'Order System' FROM patient_orders
UNION ALL
SELECT 'Total Order Items', COUNT(*)::TEXT, 'Order System' FROM patient_order_items
UNION ALL
SELECT 'Total Rx Items', COUNT(*)::TEXT, 'Order System' FROM rx_items
UNION ALL
SELECT 'Total Triage Records', COUNT(*)::TEXT, 'Visit Narrative' FROM triage
UNION ALL
SELECT 'Total Visit Narratives', COUNT(*)::TEXT, 'Visit Narrative' FROM visit_narratives
UNION ALL
SELECT 'Total Departments', COUNT(*)::TEXT, 'Inpatient Management' FROM departments
UNION ALL
SELECT 'Total Wards', COUNT(*)::TEXT, 'Inpatient Management' FROM wards
UNION ALL
SELECT 'Total Beds', COUNT(*)::TEXT, 'Inpatient Management' FROM beds
UNION ALL
SELECT 'Total Waitlist Entries', COUNT(*)::TEXT, 'Inpatient Management' FROM waitlist
UNION ALL
SELECT 'Total IPD Tasks', COUNT(*)::TEXT, 'Inpatient Management' FROM ipd_tasks
UNION ALL
SELECT 'Total IPD Charges', COUNT(*)::TEXT, 'Inpatient Management' FROM ipd_charges
UNION ALL
SELECT 'Total Lexicon Terms', COUNT(*)::TEXT, 'NLP Infrastructure' FROM lexicon_terms
UNION ALL
SELECT 'Total Patient Identifiers', COUNT(*)::TEXT, 'Identity & Access' FROM patient_identifiers
UNION ALL
SELECT 'Total KPI Definitions', COUNT(*)::TEXT, 'Infrastructure' FROM kpi_definitions
UNION ALL
SELECT 'Total KPI Values', COUNT(*)::TEXT, 'Infrastructure' FROM kpi_values
UNION ALL
SELECT 'Total Audit Log Entries', COUNT(*)::TEXT, 'Infrastructure' FROM audit_log
UNION ALL
SELECT 'Total Outbox Events', COUNT(*)::TEXT, 'Infrastructure' FROM outbox_events;

-- Step 9: Grant execute permissions on validation functions to authenticated users
GRANT EXECUTE ON FUNCTION public.validate_tenant_isolation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_order_migration() TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_rls_coverage() TO authenticated;

-- Step 10: Add documentation
COMMENT ON FUNCTION public.validate_tenant_isolation() IS 'Validates that all records have proper tenant_id assignment';
COMMENT ON FUNCTION public.validate_order_migration() IS 'Validates completeness of order system migration from legacy to normalized structure';
COMMENT ON FUNCTION public.check_rls_coverage() IS 'Audits RLS policy coverage across all tables';
COMMENT ON VIEW public.v_architecture_summary IS 'High-level summary of data volumes across all architectural domains';