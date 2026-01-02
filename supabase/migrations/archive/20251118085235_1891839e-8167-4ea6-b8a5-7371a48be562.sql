-- Drop and recreate nurse_dashboard_queue materialized view with vital sign columns
DROP MATERIALIZED VIEW IF EXISTS public.nurse_dashboard_queue;

CREATE MATERIALIZED VIEW public.nurse_dashboard_queue AS
SELECT 
  v.id AS visit_id,
  v.patient_id,
  v.facility_id,
  v.status AS visit_status,
  v.created_at AS visit_created_at,
  v.assigned_doctor,
  v.opd_room,
  v.consultation_payment_type,
  -- Vital signs columns (using actual column names from visits table)
  v.temperature,
  v.blood_pressure,
  v.heart_rate AS pulse,
  v.respiratory_rate,
  v.oxygen_saturation AS spo2,
  v.weight,
  v.triage_triggers AS observations,
  -- Patient info
  p.full_name AS patient_name,
  p.date_of_birth,
  p.gender,
  p.phone AS patient_phone,
  p.fayida_id AS national_id
FROM public.visits v
INNER JOIN public.patients p ON v.patient_id = p.id
WHERE v.status IN ('waiting_triage', 'in_triage', 'vitals_taken', 'with_doctor', 'at_triage')
  AND v.status != 'discharged';

-- Recreate the unique index for concurrent refresh
CREATE UNIQUE INDEX idx_nurse_queue_visit_id 
  ON public.nurse_dashboard_queue(visit_id);

-- Create additional indexes for performance
CREATE INDEX idx_nurse_queue_facility_status 
  ON public.nurse_dashboard_queue(facility_id, visit_status);

CREATE INDEX idx_nurse_queue_created 
  ON public.nurse_dashboard_queue(visit_created_at DESC);

-- Add comment
COMMENT ON MATERIALIZED VIEW public.nurse_dashboard_queue IS 
  'Optimized queue view for nurse dashboard with vital signs included';