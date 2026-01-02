-- Drop and recreate view to add opd_room field
DROP VIEW IF EXISTS public.nurse_dashboard_queue;

CREATE VIEW public.nurse_dashboard_queue AS
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
  v.opd_room,  -- Department assignment
  
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