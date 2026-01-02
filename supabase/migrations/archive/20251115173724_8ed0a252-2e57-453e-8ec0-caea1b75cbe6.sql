-- Comprehensive Cashier Dashboard Performance Optimization
-- This migration creates optimized database functions and indices for payment queries

-- ============================================================================
-- PART 1: Optimized function for pending bills
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_pending_bills(p_facility_id uuid)
RETURNS TABLE(
  id uuid,
  visit_id uuid,
  patient_id uuid,
  patient_name text,
  patient_phone text,
  item_type text,
  item_name text,
  amount numeric,
  quantity integer,
  payment_status text,
  created_at timestamptz,
  visit_date date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  -- Unpaid medication orders
  SELECT 
    mo.id,
    mo.visit_id,
    mo.patient_id,
    p.full_name as patient_name,
    p.phone as patient_phone,
    'medication'::text as item_type,
    mo.medication_name as item_name,
    mo.amount,
    mo.quantity,
    mo.payment_status,
    mo.created_at,
    v.visit_date
  FROM medication_orders mo
  JOIN patients p ON p.id = mo.patient_id
  JOIN visits v ON v.id = mo.visit_id
  WHERE v.facility_id = p_facility_id
    AND mo.payment_status = 'unpaid'
    AND mo.tenant_id = (SELECT tenant_id FROM facilities WHERE id = p_facility_id)

  UNION ALL

  -- Unpaid lab orders
  SELECT 
    lo.id,
    lo.visit_id,
    lo.patient_id,
    p.full_name,
    p.phone,
    'lab'::text,
    lo.test_name,
    lo.amount,
    1 as quantity,
    lo.payment_status,
    lo.created_at,
    v.visit_date
  FROM lab_orders lo
  JOIN patients p ON p.id = lo.patient_id
  JOIN visits v ON v.id = lo.visit_id
  WHERE v.facility_id = p_facility_id
    AND lo.payment_status = 'unpaid'
    AND lo.tenant_id = (SELECT tenant_id FROM facilities WHERE id = p_facility_id)

  UNION ALL

  -- Unpaid imaging orders
  SELECT 
    io.id,
    io.visit_id,
    io.patient_id,
    p.full_name,
    p.phone,
    'imaging'::text,
    io.study_name,
    io.amount,
    1 as quantity,
    io.payment_status,
    io.created_at,
    v.visit_date
  FROM imaging_orders io
  JOIN patients p ON p.id = io.patient_id
  JOIN visits v ON v.id = io.visit_id
  WHERE v.facility_id = p_facility_id
    AND io.payment_status = 'unpaid'
    AND io.tenant_id = (SELECT tenant_id FROM facilities WHERE id = p_facility_id)

  UNION ALL

  -- Unpaid billing items (including consultation fees)
  SELECT 
    bi.id,
    bi.visit_id,
    bi.patient_id,
    p.full_name,
    p.phone,
    'service'::text,
    ms.name,
    bi.total_amount,
    bi.quantity,
    bi.payment_status,
    bi.created_at,
    v.visit_date
  FROM billing_items bi
  JOIN patients p ON p.id = bi.patient_id
  JOIN visits v ON v.id = bi.visit_id
  JOIN medical_services ms ON ms.id = bi.service_id
  WHERE v.facility_id = p_facility_id
    AND bi.payment_status = 'unpaid'
    AND bi.tenant_id = (SELECT tenant_id FROM facilities WHERE id = p_facility_id)

  ORDER BY created_at DESC;
END;
$$;

-- ============================================================================
-- PART 2: Optimized function for daily collections
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_daily_collections(
  p_facility_id uuid,
  p_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  id uuid,
  visit_id uuid,
  patient_id uuid,
  patient_name text,
  item_type text,
  item_name text,
  amount numeric,
  payment_mode text,
  paid_at timestamptz,
  visit_date date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  -- Paid medication orders
  SELECT 
    mo.id,
    mo.visit_id,
    mo.patient_id,
    p.full_name as patient_name,
    'medication'::text as item_type,
    mo.medication_name as item_name,
    mo.amount,
    mo.payment_mode,
    mo.paid_at,
    v.visit_date
  FROM medication_orders mo
  JOIN patients p ON p.id = mo.patient_id
  JOIN visits v ON v.id = mo.visit_id
  WHERE v.facility_id = p_facility_id
    AND mo.payment_status = 'paid'
    AND DATE(mo.paid_at) = p_date
    AND mo.tenant_id = (SELECT tenant_id FROM facilities WHERE id = p_facility_id)

  UNION ALL

  -- Paid lab orders
  SELECT 
    lo.id,
    lo.visit_id,
    lo.patient_id,
    p.full_name,
    'lab'::text,
    lo.test_name,
    lo.amount,
    lo.payment_mode,
    lo.paid_at,
    v.visit_date
  FROM lab_orders lo
  JOIN patients p ON p.id = lo.patient_id
  JOIN visits v ON v.id = lo.visit_id
  WHERE v.facility_id = p_facility_id
    AND lo.payment_status = 'paid'
    AND DATE(lo.paid_at) = p_date
    AND lo.tenant_id = (SELECT tenant_id FROM facilities WHERE id = p_facility_id)

  UNION ALL

  -- Paid imaging orders
  SELECT 
    io.id,
    io.visit_id,
    io.patient_id,
    p.full_name,
    'imaging'::text,
    io.study_name,
    io.amount,
    io.payment_mode,
    io.paid_at,
    v.visit_date
  FROM imaging_orders io
  JOIN patients p ON p.id = io.patient_id
  JOIN visits v ON v.id = io.visit_id
  WHERE v.facility_id = p_facility_id
    AND io.payment_status = 'paid'
    AND DATE(io.paid_at) = p_date
    AND io.tenant_id = (SELECT tenant_id FROM facilities WHERE id = p_facility_id)

  UNION ALL

  -- Paid billing items
  SELECT 
    bi.id,
    bi.visit_id,
    bi.patient_id,
    p.full_name,
    'service'::text,
    ms.name,
    bi.total_amount,
    bi.payment_mode,
    bi.paid_at,
    v.visit_date
  FROM billing_items bi
  JOIN patients p ON p.id = bi.patient_id
  JOIN visits v ON v.id = bi.visit_id
  JOIN medical_services ms ON ms.id = bi.service_id
  WHERE v.facility_id = p_facility_id
    AND bi.payment_status = 'paid'
    AND DATE(bi.paid_at) = p_date
    AND bi.tenant_id = (SELECT tenant_id FROM facilities WHERE id = p_facility_id)

  ORDER BY paid_at DESC;
END;
$$;

-- ============================================================================
-- PART 3: Comprehensive indexing strategy for payment queries
-- ============================================================================

-- Indices for medication_orders payment queries
CREATE INDEX IF NOT EXISTS idx_medication_orders_payment_facility 
  ON medication_orders(payment_status, tenant_id) 
  WHERE payment_status = 'unpaid';

CREATE INDEX IF NOT EXISTS idx_medication_orders_paid_date 
  ON medication_orders(payment_status, paid_at, tenant_id) 
  WHERE payment_status = 'paid';

-- Indices for lab_orders payment queries
CREATE INDEX IF NOT EXISTS idx_lab_orders_payment_facility 
  ON lab_orders(payment_status, tenant_id) 
  WHERE payment_status = 'unpaid';

CREATE INDEX IF NOT EXISTS idx_lab_orders_paid_date 
  ON lab_orders(payment_status, paid_at, tenant_id) 
  WHERE payment_status = 'paid';

-- Indices for imaging_orders payment queries
CREATE INDEX IF NOT EXISTS idx_imaging_orders_payment_facility 
  ON imaging_orders(payment_status, tenant_id) 
  WHERE payment_status = 'unpaid';

CREATE INDEX IF NOT EXISTS idx_imaging_orders_paid_date 
  ON imaging_orders(payment_status, paid_at, tenant_id) 
  WHERE payment_status = 'paid';

-- Indices for billing_items payment queries
CREATE INDEX IF NOT EXISTS idx_billing_items_payment_facility 
  ON billing_items(payment_status, tenant_id) 
  WHERE payment_status = 'unpaid';

CREATE INDEX IF NOT EXISTS idx_billing_items_paid_date 
  ON billing_items(payment_status, paid_at, tenant_id) 
  WHERE payment_status = 'paid';

-- Composite index for visits facility lookups (used in all joins)
CREATE INDEX IF NOT EXISTS idx_visits_facility_date 
  ON visits(facility_id, visit_date, tenant_id);

-- ============================================================================
-- PART 4: Grant permissions
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.get_pending_bills(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_collections(uuid, date) TO authenticated;