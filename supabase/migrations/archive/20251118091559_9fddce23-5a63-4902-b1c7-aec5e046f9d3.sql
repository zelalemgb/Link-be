-- Drop the materialized view approach (wrong tool for frequently-changing data)
DROP MATERIALIZED VIEW IF EXISTS public.nurse_dashboard_queue CASCADE;
DROP TRIGGER IF EXISTS trigger_refresh_nurse_queue_on_vital_update ON visits;
DROP TRIGGER IF EXISTS trigger_refresh_nurse_queue_on_insert ON visits;
DROP FUNCTION IF EXISTS refresh_nurse_queue_on_vital_update();

-- Create a regular VIEW (always up-to-date, no caching)
CREATE OR REPLACE VIEW public.nurse_dashboard_queue AS
SELECT 
  v.id AS visit_id,
  v.patient_id,
  v.facility_id,
  v.status AS current_stage,
  v.created_at AS visit_date,
  v.reason AS visit_reason,
  v.assigned_doctor AS provider,
  v.pain_score,
  v.visit_notes,
  v.tenant_id,
  v.assessment_completed,
  v.assessed_at,
  v.assessed_by,
  
  -- Vital signs (always fresh from visits table)
  v.temperature,
  v.blood_pressure,
  v.heart_rate AS pulse,
  v.respiratory_rate,
  v.oxygen_saturation AS spo2,
  v.weight,
  v.triage_triggers AS observations,
  
  -- Journey timeline
  v.journey_timeline,
  
  -- Patient information
  p.full_name AS patient_name,
  p.date_of_birth,
  EXTRACT(YEAR FROM AGE(p.date_of_birth))::INTEGER AS patient_age,
  p.gender AS patient_gender,
  p.phone,
  p.fayida_id,
  
  -- Payment information
  v.consultation_payment_type AS payment_type,
  CASE 
    WHEN v.consultation_payment_type IN ('insured', 'free', 'credit') THEN 'paid'
    WHEN v.fee_paid > 0 THEN 'paid'
    ELSE 'unpaid'
  END AS payment_status,
  
  v.updated_at
FROM 
  public.visits v
  LEFT JOIN public.patients p ON v.patient_id = p.id
WHERE 
  v.status IN ('registered', 'waiting_triage', 'in_triage', 'vitals_taken', 'with_doctor', 'at_triage');

-- Add performance indexes on the underlying tables
CREATE INDEX IF NOT EXISTS idx_visits_facility_status ON public.visits(facility_id, status) WHERE status IN ('registered', 'waiting_triage', 'in_triage', 'vitals_taken', 'with_doctor', 'at_triage');
CREATE INDEX IF NOT EXISTS idx_visits_created_at ON public.visits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_updated_at ON public.visits(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_patients_id ON public.patients(id);