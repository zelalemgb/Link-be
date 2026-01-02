-- Create a reusable view that rolls up visit payment information from payments,
-- payment_line_items, billing items and diagnostic orders so every dashboard
-- uses a single source of truth.
DROP VIEW IF EXISTS public.visit_payment_status;

CREATE VIEW public.visit_payment_status AS
WITH order_payments AS (
  SELECT visit_id, payment_status FROM public.medication_orders
  UNION ALL
  SELECT visit_id, payment_status FROM public.lab_orders
  UNION ALL
  SELECT visit_id, payment_status FROM public.imaging_orders
  UNION ALL
  SELECT visit_id, payment_status FROM public.billing_items
),
order_rollup AS (
  SELECT
    visit_id,
    bool_or(payment_status NOT IN ('paid', 'waived')) AS has_unpaid_items
  FROM order_payments
  GROUP BY visit_id
),
consultation_payments AS (
  SELECT
    bi.visit_id,
    bool_or(bi.payment_status IN ('paid', 'waived')) AS consultation_fee_paid
  FROM public.billing_items bi
  LEFT JOIN public.medical_services ms ON ms.id = bi.service_id
  WHERE COALESCE(ms.category, '') ILIKE 'consult%'
     OR COALESCE(ms.name, '') ILIKE '%consult%'
  GROUP BY bi.visit_id
),
payment_receipts AS (
  SELECT
    visit_id,
    max(updated_at) AS last_payment_at,
    bool_or(payment_status = 'paid') AS any_paid,
    bool_or(payment_status = 'partial') AS any_partial,
    bool_or(payment_status = 'pending') AS any_pending
  FROM public.payments
  GROUP BY visit_id
)
SELECT
  v.id AS visit_id,
  CASE
    WHEN v.consultation_payment_type IN ('free', 'insured', 'credit') THEN 'waived'
    WHEN COALESCE(cp.consultation_fee_paid, false) OR v.fee_paid > 0 THEN 'paid'
    ELSE 'unpaid'
  END AS consultation_payment_status,
  CASE
    WHEN COALESCE(oroll.has_unpaid_items, false) THEN 'unpaid'
    WHEN COALESCE(prece.any_paid, false) THEN 'paid'
    WHEN COALESCE(prece.any_partial, false) OR COALESCE(prece.any_pending, false) THEN 'pending'
    ELSE 'none'
  END AS overall_payment_status,
  COALESCE(oroll.has_unpaid_items, false) AS has_unpaid_items,
  prece.last_payment_at
FROM public.visits v
LEFT JOIN order_rollup oroll ON oroll.visit_id = v.id
LEFT JOIN consultation_payments cp ON cp.visit_id = v.id
LEFT JOIN payment_receipts prece ON prece.visit_id = v.id;

GRANT SELECT ON public.visit_payment_status TO authenticated;

-- Rebuild nurse_dashboard_queue so it consumes the new visit_payment_status view
-- and exposes richer payment metadata.
DROP MATERIALIZED VIEW IF EXISTS public.nurse_dashboard_queue CASCADE;

CREATE MATERIALIZED VIEW public.nurse_dashboard_queue AS
SELECT
  v.id AS visit_id,
  v.patient_id,
  v.facility_id,
  v.tenant_id,
  v.status AS current_stage,
  v.created_at AS visit_date,
  v.status_updated_at AS updated_at,
  v.reason AS visit_reason,
  v.assigned_doctor AS provider,
  v.assessment_completed,
  v.assessed_at,
  v.assessed_by,
  v.opd_room,
  v.journey_timeline,
  v.visit_notes,
  v.consultation_payment_type AS payment_type,
  v.temperature,
  v.blood_pressure,
  v.heart_rate AS pulse,
  v.respiratory_rate,
  v.oxygen_saturation AS spo2,
  v.weight,
  v.triage_triggers AS observations,
  p.full_name AS patient_name,
  p.age AS patient_age,
  p.gender AS patient_gender,
  p.phone,
  p.fayida_id,
  vps.consultation_payment_status,
  vps.overall_payment_status AS payment_status,
  vps.has_unpaid_items,
  vps.last_payment_at
FROM public.visits v
JOIN public.patients p ON p.id = v.patient_id
LEFT JOIN public.visit_payment_status vps ON vps.visit_id = v.id
WHERE v.status NOT IN ('discharged', 'cancelled');

CREATE UNIQUE INDEX idx_nurse_dashboard_queue_visit
  ON public.nurse_dashboard_queue(visit_id);

CREATE INDEX idx_nurse_dashboard_queue_facility_status
  ON public.nurse_dashboard_queue(facility_id, current_stage, visit_date DESC);

CREATE INDEX idx_nurse_dashboard_queue_tenant
  ON public.nurse_dashboard_queue(tenant_id);

COMMENT ON MATERIALIZED VIEW public.nurse_dashboard_queue IS
  'Nurse queue with vitals, journey metadata and unified payment status';

REFRESH MATERIALIZED VIEW public.nurse_dashboard_queue;

-- Ensure the queue stays fresh whenever payments or line items change.
DROP TRIGGER IF EXISTS refresh_dashboard_on_payments ON public.payments;
DROP TRIGGER IF EXISTS refresh_dashboard_on_payment_items ON public.payment_line_items;

CREATE TRIGGER refresh_dashboard_on_payments
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

CREATE TRIGGER refresh_dashboard_on_payment_items
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_line_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

