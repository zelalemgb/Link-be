-- Drop and recreate nurse_dashboard_queue with payment type awareness
DROP MATERIALIZED VIEW IF EXISTS public.nurse_dashboard_queue CASCADE;

CREATE MATERIALIZED VIEW public.nurse_dashboard_queue AS
SELECT 
  v.id AS visit_id,
  v.created_at AS visit_created_at,
  v.facility_id,
  v.opd_room,
  v.assigned_doctor,
  v.consultation_payment_type,
  v.insurance_provider,
  v.program_id,
  v.creditor_id,
  p.id AS patient_id,
  p.full_name AS patient_name,
  p.date_of_birth,
  p.gender,
  p.phone,
  p.fayida_id,
  COALESCE(public.get_current_journey_stage(v.journey_timeline), v.status, 'registered') AS current_stage,
  v.journey_timeline AS journey_timeline,
  -- Payment status logic that respects consultation_payment_type
  CASE
    WHEN v.consultation_payment_type IN ('insured', 'free', 'credit') THEN
      -- For insured/free/credit: only check non-consultation billing items and orders
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.billing_items bi
          JOIN public.medical_services ms ON ms.id = bi.service_id
          WHERE bi.visit_id = v.id 
          AND bi.payment_status = 'unpaid'
          AND ms.category != 'Consultation'  -- Exclude consultation fees
        )
        OR EXISTS (
          SELECT 1 FROM public.medication_orders mo
          WHERE mo.visit_id = v.id 
          AND mo.payment_status = 'unpaid'
        )
        OR EXISTS (
          SELECT 1 FROM public.lab_orders lo
          WHERE lo.visit_id = v.id 
          AND lo.payment_status = 'unpaid'
        )
        OR EXISTS (
          SELECT 1 FROM public.imaging_orders io
          WHERE io.visit_id = v.id 
          AND io.payment_status = 'unpaid'
        )
        THEN 'unpaid'
        ELSE 'paid'
      END
    ELSE
      -- For paying patients: check ALL billing items including consultation
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.billing_items bi
          WHERE bi.visit_id = v.id 
          AND bi.payment_status = 'unpaid'
        )
        OR EXISTS (
          SELECT 1 FROM public.medication_orders mo
          WHERE mo.visit_id = v.id 
          AND mo.payment_status = 'unpaid'
        )
        OR EXISTS (
          SELECT 1 FROM public.lab_orders lo
          WHERE lo.visit_id = v.id 
          AND lo.payment_status = 'unpaid'
        )
        OR EXISTS (
          SELECT 1 FROM public.imaging_orders io
          WHERE io.visit_id = v.id 
          AND io.payment_status = 'unpaid'
        )
        THEN 'unpaid'
        ELSE 'paid'
      END
  END AS payment_status
FROM public.visits v
INNER JOIN public.patients p ON p.id = v.patient_id
WHERE v.status != 'completed'
  AND v.status != 'cancelled';

-- Create performance indexes
CREATE INDEX IF NOT EXISTS idx_nurse_queue_facility_stage 
  ON public.nurse_dashboard_queue(facility_id, current_stage);

CREATE INDEX IF NOT EXISTS idx_nurse_queue_created 
  ON public.nurse_dashboard_queue(visit_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_nurse_queue_payment_type 
  ON public.nurse_dashboard_queue(consultation_payment_type);

CREATE INDEX IF NOT EXISTS idx_nurse_queue_payment_status
  ON public.nurse_dashboard_queue(payment_status);

CREATE INDEX IF NOT EXISTS idx_nurse_queue_visit_id 
  ON public.nurse_dashboard_queue(visit_id);

-- Refresh the view
REFRESH MATERIALIZED VIEW public.nurse_dashboard_queue;

-- Add comment
COMMENT ON MATERIALIZED VIEW public.nurse_dashboard_queue IS 
'Optimized nurse dashboard queue with payment status that respects consultation_payment_type. Insured/free/credit patients bypass consultation payment checks but are still validated for diagnostic/procedure payments.';