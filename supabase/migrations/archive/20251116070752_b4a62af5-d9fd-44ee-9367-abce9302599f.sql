-- Add missing fields to nurse_dashboard_queue materialized view
-- Only include columns that actually exist in visits table

DROP MATERIALIZED VIEW IF EXISTS public.nurse_dashboard_queue;

CREATE MATERIALIZED VIEW public.nurse_dashboard_queue AS
SELECT 
  v.id AS visit_id,
  v.patient_id,
  v.facility_id,
  v.tenant_id,
  v.status AS current_status,
  v.visit_date,
  v.created_at AS visit_created_at,
  v.status_updated_at,
  
  -- Patient information
  p.full_name AS patient_name,
  p.age AS patient_age,
  p.gender AS patient_gender,
  p.phone AS patient_phone,
  p.fayida_id,
  
  -- Visit metadata (only columns that exist in visits table)
  v.reason AS visit_reason,
  v.provider,
  v.assigned_doctor,
  v.assessment_completed,
  v.assessed_at,
  v.assessed_by,
  v.journey_timeline,
  v.fee_paid,
  v.opd_room,
  v.visit_notes,
  
  -- Payment status (aggregated from billing_items)
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.billing_items bi 
      WHERE bi.visit_id = v.id AND bi.payment_status = 'unpaid'
    ) THEN 'unpaid'
    WHEN EXISTS (
      SELECT 1 FROM public.billing_items bi 
      WHERE bi.visit_id = v.id AND bi.payment_status = 'paid'
    ) THEN 'paid'
    ELSE 'none'
  END AS payment_status,
  
  -- Wait time calculation
  EXTRACT(EPOCH FROM (now() - v.status_updated_at)) / 60 AS wait_time_minutes,
  
  -- Last status change info
  (
    SELECT jsonb_build_object(
      'previous_status', pse.previous_status,
      'changed_at', pse.changed_at,
      'changed_by', pse.changed_by
    )
    FROM public.patient_status_events pse
    WHERE pse.visit_id = v.id
    ORDER BY pse.changed_at DESC
    LIMIT 1
  ) AS last_status_change,
  
  -- Pending orders count
  (SELECT COUNT(*) FROM public.lab_orders lo 
   WHERE lo.visit_id = v.id AND lo.status = 'pending') AS pending_lab_orders,
  (SELECT COUNT(*) FROM public.imaging_orders io 
   WHERE io.visit_id = v.id AND io.status = 'pending') AS pending_imaging_orders,
  (SELECT COUNT(*) FROM public.medication_orders mo 
   WHERE mo.visit_id = v.id AND mo.status IN ('pending', 'approved')) AS pending_medication_orders

FROM public.visits v
INNER JOIN public.patients p ON p.id = v.patient_id
WHERE v.status NOT IN ('discharged', 'cancelled')
  AND v.visit_date >= CURRENT_DATE - INTERVAL '7 days';

-- Recreate indexes
CREATE UNIQUE INDEX idx_nurse_dashboard_queue_visit 
  ON public.nurse_dashboard_queue(visit_id);

CREATE INDEX idx_nurse_dashboard_queue_facility_status 
  ON public.nurse_dashboard_queue(facility_id, current_status, visit_created_at DESC);

CREATE INDEX idx_nurse_dashboard_queue_tenant 
  ON public.nurse_dashboard_queue(tenant_id);

-- Refresh the view with initial data
REFRESH MATERIALIZED VIEW public.nurse_dashboard_queue;