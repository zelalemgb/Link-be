-- Phase 1 Performance Optimization: Add Strategic Indexes
-- Creates indexes for existing tables with correct column names

-- ============================================================================
-- CORE ENTITY INDEXES
-- ============================================================================

-- Patients
CREATE INDEX IF NOT EXISTS idx_patients_tenant_facility 
  ON patients(tenant_id, facility_id) WHERE facility_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patients_created_at 
  ON patients(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patients_phone 
  ON patients(phone) WHERE phone IS NOT NULL;

-- Visits
CREATE INDEX IF NOT EXISTS idx_visits_tenant_facility 
  ON visits(tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_visits_status_date 
  ON visits(status, visit_date DESC) WHERE status != 'checked_out';

CREATE INDEX IF NOT EXISTS idx_visits_patient_date 
  ON visits(patient_id, visit_date DESC);

CREATE INDEX IF NOT EXISTS idx_visits_created_at 
  ON visits(created_at DESC);

-- ============================================================================
-- ORDERS AND CLINICAL DATA INDEXES
-- ============================================================================

-- Lab orders
CREATE INDEX IF NOT EXISTS idx_lab_orders_tenant 
  ON lab_orders(tenant_id);

CREATE INDEX IF NOT EXISTS idx_lab_orders_status_ordered 
  ON lab_orders(status, ordered_at DESC) WHERE status IN ('pending', 'collected');

CREATE INDEX IF NOT EXISTS idx_lab_orders_visit 
  ON lab_orders(visit_id);

CREATE INDEX IF NOT EXISTS idx_lab_orders_patient 
  ON lab_orders(patient_id);

-- Medication orders
CREATE INDEX IF NOT EXISTS idx_medication_orders_tenant 
  ON medication_orders(tenant_id);

CREATE INDEX IF NOT EXISTS idx_medication_orders_status 
  ON medication_orders(status, ordered_at DESC) WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS idx_medication_orders_visit 
  ON medication_orders(visit_id);

CREATE INDEX IF NOT EXISTS idx_medication_orders_patient 
  ON medication_orders(patient_id);

-- Imaging orders
CREATE INDEX IF NOT EXISTS idx_imaging_orders_tenant 
  ON imaging_orders(tenant_id);

CREATE INDEX IF NOT EXISTS idx_imaging_orders_status_urgency 
  ON imaging_orders(status, urgency, ordered_at DESC) WHERE status != 'completed';

CREATE INDEX IF NOT EXISTS idx_imaging_orders_visit 
  ON imaging_orders(visit_id);

-- ============================================================================
-- FINANCIAL DATA INDEXES
-- ============================================================================

-- Billing items
CREATE INDEX IF NOT EXISTS idx_billing_items_tenant 
  ON billing_items(tenant_id);

CREATE INDEX IF NOT EXISTS idx_billing_items_status 
  ON billing_items(payment_status, created_at DESC) WHERE payment_status = 'unpaid';

CREATE INDEX IF NOT EXISTS idx_billing_items_visit 
  ON billing_items(visit_id);

CREATE INDEX IF NOT EXISTS idx_billing_items_patient 
  ON billing_items(patient_id);

-- Payments
CREATE INDEX IF NOT EXISTS idx_payments_tenant_facility 
  ON payments(tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_payments_status_created 
  ON payments(payment_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_visit 
  ON payments(visit_id);

-- Payment transactions
CREATE INDEX IF NOT EXISTS idx_payment_transactions_payment 
  ON payment_transactions(payment_id, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_cashier 
  ON payment_transactions(cashier_id, transaction_date DESC);

-- ============================================================================
-- INVENTORY INDEXES
-- ============================================================================

-- Stock movements
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_facility 
  ON stock_movements(tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_item_date 
  ON stock_movements(inventory_item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_type_date 
  ON stock_movements(movement_type, created_at DESC);

-- ============================================================================
-- USER AND FACILITY INDEXES
-- ============================================================================

-- Users
CREATE INDEX IF NOT EXISTS idx_users_auth_user 
  ON users(auth_user_id);

CREATE INDEX IF NOT EXISTS idx_users_tenant_facility 
  ON users(tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_users_role 
  ON users(user_role);

-- Facilities
CREATE INDEX IF NOT EXISTS idx_facilities_tenant 
  ON facilities(tenant_id) WHERE verified = true;

CREATE INDEX IF NOT EXISTS idx_facilities_admin 
  ON facilities(admin_user_id);

-- ============================================================================
-- KPI AND ANALYTICS INDEXES
-- ============================================================================

-- KPI values
CREATE INDEX IF NOT EXISTS idx_kpi_values_tenant_facility_date 
  ON kpi_values(tenant_id, facility_id, measurement_date DESC);

CREATE INDEX IF NOT EXISTS idx_kpi_values_definition_date 
  ON kpi_values(kpi_definition_id, measurement_date DESC);

-- KPI definitions
CREATE INDEX IF NOT EXISTS idx_kpi_definitions_tenant 
  ON kpi_definitions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_kpi_definitions_kpi_code 
  ON kpi_definitions(kpi_code) WHERE kpi_code IS NOT NULL;

-- KPI targets
CREATE INDEX IF NOT EXISTS idx_kpi_targets_tenant_facility 
  ON kpi_targets(tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_kpi_targets_definition 
  ON kpi_targets(kpi_definition_id);

COMMENT ON INDEX idx_visits_tenant_facility IS 'Composite index for tenant-scoped visit queries';
COMMENT ON INDEX idx_visits_status_date IS 'Optimizes active visit filtering for dashboards';
COMMENT ON INDEX idx_lab_orders_status_ordered IS 'Speeds up pending/collected lab order queries';
COMMENT ON INDEX idx_kpi_values_tenant_facility_date IS 'Optimizes KPI time-series queries for analytics';