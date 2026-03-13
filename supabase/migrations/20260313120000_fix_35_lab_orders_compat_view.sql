-- Preserve the legacy v_lab_orders_with_patient contract while resolving
-- sample metadata through the new master-row linkage.

CREATE OR REPLACE VIEW public.v_lab_orders_with_patient AS
SELECT
  lo.id,
  lo.visit_id,
  lo.patient_id,
  lo.ordered_by,
  lo.test_name,
  lo.test_code,
  lo.urgency,
  lo.status,
  lo.result,
  lo.result_value,
  lo.reference_range,
  lo.notes,
  lo.ordered_at,
  lo.collected_at,
  lo.completed_at,
  lo.created_at,
  lo.updated_at,
  lo.rejection_reason,
  lo.rejected_by,
  lo.rejected_at,
  lo.payment_status,
  lo.payment_mode,
  lo.amount,
  lo.paid_at,
  lo.sent_outside,
  lo.tenant_id,
  p.full_name AS patient_full_name,
  p.age AS patient_age,
  p.gender AS patient_gender,
  ltm.sample_type
FROM public.lab_orders lo
JOIN public.patients p ON p.id = lo.patient_id
LEFT JOIN public.visits v ON v.id = lo.visit_id
LEFT JOIN LATERAL (
  SELECT ltm_inner.sample_type
  FROM public.lab_test_master ltm_inner
  WHERE ltm_inner.id = COALESCE(
    lo.lab_test_master_id,
    public.resolve_scoped_lab_test_master_id(
      lo.tenant_id,
      v.facility_id,
      lo.test_code,
      lo.test_name
    )
  )
  LIMIT 1
) ltm ON TRUE;
