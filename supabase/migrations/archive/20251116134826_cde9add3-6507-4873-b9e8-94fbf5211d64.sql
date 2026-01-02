-- Drop and recreate nurse_dashboard_queue view to include current_journey_stage
DROP MATERIALIZED VIEW IF EXISTS nurse_dashboard_queue CASCADE;

CREATE MATERIALIZED VIEW nurse_dashboard_queue AS
SELECT 
  v.id AS visit_id,
  v.patient_id,
  v.facility_id,
  v.tenant_id,
  v.visit_date,
  v.created_at AS visit_created_at,
  v.status AS current_status,
  v.status_updated_at,
  v.journey_timeline,
  get_current_journey_stage(v.journey_timeline) AS current_journey_stage,
  v.reason AS visit_reason,
  v.visit_notes,
  v.provider,
  v.fee_paid,
  v.opd_room,
  v.assigned_doctor,
  v.assessed_at,
  v.assessed_by,
  v.assessment_completed,
  p.fayida_id,
  p.full_name AS patient_name,
  p.phone AS patient_phone,
  p.age AS patient_age,
  p.gender AS patient_gender,
  EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 60 AS wait_time_minutes,
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM billing_items bi 
      WHERE bi.visit_id = v.id 
      AND bi.payment_status IN ('unpaid', 'pending', 'partial')
    ) THEN 'unpaid'
    WHEN EXISTS (
      SELECT 1 FROM medication_orders mo 
      WHERE mo.visit_id = v.id 
      AND mo.payment_status IN ('unpaid', 'pending', 'partial')
    ) THEN 'unpaid'
    WHEN EXISTS (
      SELECT 1 FROM lab_orders lo 
      WHERE lo.visit_id = v.id 
      AND lo.payment_status IN ('unpaid', 'pending', 'partial')
    ) THEN 'unpaid'
    WHEN EXISTS (
      SELECT 1 FROM imaging_orders io 
      WHERE io.visit_id = v.id 
      AND io.payment_status IN ('unpaid', 'pending', 'partial')
    ) THEN 'unpaid'
    ELSE 'paid'
  END AS payment_status,
  (SELECT COUNT(*) FROM medication_orders mo WHERE mo.visit_id = v.id AND mo.status = 'pending') AS pending_medication_orders,
  (SELECT COUNT(*) FROM lab_orders lo WHERE lo.visit_id = v.id AND lo.status IN ('pending', 'in_progress')) AS pending_lab_orders,
  (SELECT COUNT(*) FROM imaging_orders io WHERE io.visit_id = v.id AND io.status IN ('pending', 'scheduled', 'in_progress')) AS pending_imaging_orders,
  jsonb_build_object(
    'from', LAG(v.status) OVER (PARTITION BY v.id ORDER BY v.status_updated_at),
    'to', v.status,
    'at', v.status_updated_at
  ) AS last_status_change
FROM visits v
LEFT JOIN patients p ON v.patient_id = p.id
WHERE v.created_at >= CURRENT_DATE - INTERVAL '7 days';

-- Create index on the materialized view for fast filtering
CREATE INDEX idx_nurse_queue_facility_journey_stage ON nurse_dashboard_queue(facility_id, current_journey_stage);
CREATE INDEX idx_nurse_queue_created ON nurse_dashboard_queue(visit_created_at DESC);
CREATE UNIQUE INDEX idx_nurse_queue_visit_id ON nurse_dashboard_queue(visit_id);