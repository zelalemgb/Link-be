-- The previous migration could leave either a VIEW or MATERIALIZED VIEW named
-- nurse_dashboard_queue in place. Drop whichever exists before rebuilding the
-- queue with the refined payment logic.
DROP VIEW IF EXISTS public.visit_payment_status CASCADE;

DO $$
BEGIN
  IF to_regclass('public.nurse_dashboard_queue') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM pg_matviews
      WHERE schemaname = 'public'
        AND matviewname = 'nurse_dashboard_queue'
    ) THEN
      EXECUTE 'DROP MATERIALIZED VIEW public.nurse_dashboard_queue';
    ELSE
      EXECUTE 'DROP VIEW public.nurse_dashboard_queue';
    END IF;
  END IF;
END;
$$;

CREATE VIEW public.visit_payment_status AS
WITH line_items AS (
  SELECT
    pay.visit_id,
    pli.item_type,
    pli.payment_status,
    pli.final_amount
  FROM public.payments pay
  JOIN public.payment_line_items pli ON pli.payment_id = pay.id
),
line_rollup AS (
  SELECT
    visit_id,
    bool_or(payment_status NOT IN ('paid','waived')) AS has_unpaid_items,
    bool_or(payment_status = 'pending') AS has_pending,
    bool_or(payment_status = 'partial') AS has_partial,
    bool_or(payment_status = 'paid') AS has_paid
  FROM line_items
  GROUP BY visit_id
),
consultation_rollup AS (
  SELECT
    visit_id,
    bool_or(payment_status IN ('paid','waived')) AS consultation_fee_paid
  FROM line_items
  WHERE item_type = 'consultation'
  GROUP BY visit_id
),
payment_activity AS (
  SELECT
    visit_id,
    max(updated_at) AS last_payment_at
  FROM public.payments
  GROUP BY visit_id
)
SELECT
  v.id AS visit_id,
  CASE
    WHEN v.consultation_payment_type IN ('free','insured','credit') THEN 'waived'
    WHEN COALESCE(cr.consultation_fee_paid, false) OR v.fee_paid > 0 THEN 'paid'
    ELSE 'unpaid'
  END AS consultation_payment_status,
  CASE
    WHEN COALESCE(lr.has_unpaid_items, false) THEN 'unpaid'
    WHEN COALESCE(lr.has_partial, false) OR COALESCE(lr.has_pending, false) THEN 'pending'
    WHEN COALESCE(lr.has_paid, false) THEN 'paid'
    ELSE 'none'
  END AS overall_payment_status,
  COALESCE(lr.has_unpaid_items, false) AS has_unpaid_items,
  pa.last_payment_at
FROM public.visits v
LEFT JOIN line_rollup lr ON lr.visit_id = v.id
LEFT JOIN consultation_rollup cr ON cr.visit_id = v.id
LEFT JOIN payment_activity pa ON pa.visit_id = v.id;

GRANT SELECT ON public.visit_payment_status TO authenticated;

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
WHERE v.status NOT IN ('discharged','cancelled');

CREATE UNIQUE INDEX idx_nurse_dashboard_queue_visit ON public.nurse_dashboard_queue(visit_id);
CREATE INDEX idx_nurse_dashboard_queue_facility_status ON public.nurse_dashboard_queue(facility_id, current_stage, visit_date DESC);
CREATE INDEX idx_nurse_dashboard_queue_tenant ON public.nurse_dashboard_queue(tenant_id);

COMMENT ON MATERIALIZED VIEW public.nurse_dashboard_queue IS
  'Nurse queue with vitals, journey metadata and unified payment status.';

GRANT SELECT ON public.nurse_dashboard_queue TO authenticated;

-- Recreate the helper that all refresh triggers call so we are sure the body
-- matches the refined queue definition regardless of prior state.
CREATE OR REPLACE FUNCTION public.refresh_nurse_dashboard_queue()
RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.nurse_dashboard_queue;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

COMMENT ON FUNCTION public.refresh_nurse_dashboard_queue()
IS 'Auto-refreshes nurse_dashboard_queue materialized view when related data changes';

REFRESH MATERIALIZED VIEW public.nurse_dashboard_queue;
-- Ensure payment activity keeps the queue fresh
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
