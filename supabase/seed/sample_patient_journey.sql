-- Sample patient journey data for beta testing
-- Run this directly in Supabase SQL Editor

DO $$
DECLARE
  v_facility_id uuid;
  v_tenant_id uuid;
  v_doctor_id uuid;
  v_patient_id uuid;
  v_visit_id uuid;
BEGIN
  -- Get first facility and tenant
  SELECT id, tenant_id INTO v_facility_id, v_tenant_id
  FROM public.facilities
  ORDER BY created_at
  LIMIT 1;

  IF v_facility_id IS NULL THEN
    RAISE EXCEPTION 'No facility found. Please create a facility first.';
  END IF;

  -- Get a doctor user
  SELECT id INTO v_doctor_id
  FROM public.users
  WHERE tenant_id = v_tenant_id AND user_role = 'doctor'
  LIMIT 1;

  -- Insert sample patients if not exist
  INSERT INTO public.patients (tenant_id, facility_id, first_name, last_name, date_of_birth, sex, phone, mrn)
  VALUES
    (v_tenant_id, v_facility_id, 'Abebe', 'Bekele', '1985-03-15', 'male', '+251911234567', 'MRN-DEMO-001'),
    (v_tenant_id, v_facility_id, 'Tigist', 'Haile', '1990-07-22', 'female', '+251922345678', 'MRN-DEMO-002'),
    (v_tenant_id, v_facility_id, 'Yonas', 'Tadesse', '1978-11-08', 'male', '+251933456789', 'MRN-DEMO-003'),
    (v_tenant_id, v_facility_id, 'Marta', 'Gebre', '1995-02-14', 'female', '+251944567890', 'MRN-DEMO-004'),
    (v_tenant_id, v_facility_id, 'Dawit', 'Alemu', '2000-09-30', 'male', '+251955678901', 'MRN-DEMO-005'),
    (v_tenant_id, v_facility_id, 'Sara', 'Worku', '1988-05-18', 'female', '+251966789012', 'MRN-DEMO-006'),
    (v_tenant_id, v_facility_id, 'Henok', 'Desta', '1972-12-25', 'male', '+251977890123', 'MRN-DEMO-007'),
    (v_tenant_id, v_facility_id, 'Bethlehem', 'Kebede', '1998-08-03', 'female', '+251988901234', 'MRN-DEMO-008')
  ON CONFLICT (mrn, tenant_id) DO NOTHING;

  -- Patient 1: At Triage
  SELECT id INTO v_patient_id FROM public.patients WHERE mrn = 'MRN-DEMO-001' AND tenant_id = v_tenant_id;
  INSERT INTO public.visits (tenant_id, facility_id, patient_id, visit_date, visit_type, status, journey_stage, current_journey_stage, routing_status, chief_complaint, priority, created_at)
  VALUES (v_tenant_id, v_facility_id, v_patient_id, CURRENT_DATE, 'walk_in', 'in_progress', 'at_triage', 'at_triage', 'routing_in_progress', 'Headache and fever for 2 days', 'routine', NOW() - INTERVAL '45 minutes')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_visit_id;
  
  IF v_visit_id IS NOT NULL THEN
    INSERT INTO public.journey_timeline (visit_id, stage, arrived_at, completed_at, wait_time_minutes, notes)
    VALUES 
      (v_visit_id, 'reception', NOW() - INTERVAL '45 minutes', NOW() - INTERVAL '30 minutes', 5, 'Patient registered at reception'),
      (v_visit_id, 'at_triage', NOW() - INTERVAL '15 minutes', NULL, NULL, 'Waiting for triage assessment')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Patient 2: With Doctor
  SELECT id INTO v_patient_id FROM public.patients WHERE mrn = 'MRN-DEMO-002' AND tenant_id = v_tenant_id;
  INSERT INTO public.visits (tenant_id, facility_id, patient_id, visit_date, visit_type, status, journey_stage, current_journey_stage, routing_status, chief_complaint, priority, created_at)
  VALUES (v_tenant_id, v_facility_id, v_patient_id, CURRENT_DATE, 'walk_in', 'in_progress', 'with_doctor', 'with_doctor', 'routing_in_progress', 'Abdominal pain', 'urgent', NOW() - INTERVAL '90 minutes')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_visit_id;
  
  IF v_visit_id IS NOT NULL THEN
    INSERT INTO public.journey_timeline (visit_id, stage, arrived_at, completed_at, wait_time_minutes, notes)
    VALUES 
      (v_visit_id, 'reception', NOW() - INTERVAL '90 minutes', NOW() - INTERVAL '65 minutes', 10, 'Patient registered'),
      (v_visit_id, 'at_triage', NOW() - INTERVAL '65 minutes', NOW() - INTERVAL '40 minutes', 12, 'Vitals: BP 140/90, Temp 37.2°C'),
      (v_visit_id, 'with_doctor', NOW() - INTERVAL '25 minutes', NULL, NULL, 'With Dr. for consultation')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Patient 3: At Lab
  SELECT id INTO v_patient_id FROM public.patients WHERE mrn = 'MRN-DEMO-003' AND tenant_id = v_tenant_id;
  INSERT INTO public.visits (tenant_id, facility_id, patient_id, visit_date, visit_type, status, journey_stage, current_journey_stage, routing_status, chief_complaint, priority, created_at)
  VALUES (v_tenant_id, v_facility_id, v_patient_id, CURRENT_DATE, 'scheduled', 'in_progress', 'at_lab', 'at_lab', 'routing_in_progress', 'Routine checkup - diabetes follow-up', 'routine', NOW() - INTERVAL '120 minutes')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_visit_id;
  
  IF v_visit_id IS NOT NULL AND v_doctor_id IS NOT NULL THEN
    INSERT INTO public.journey_timeline (visit_id, stage, arrived_at, completed_at, wait_time_minutes, notes)
    VALUES 
      (v_visit_id, 'reception', NOW() - INTERVAL '120 minutes', NOW() - INTERVAL '105 minutes', 8, 'Scheduled appointment'),
      (v_visit_id, 'at_triage', NOW() - INTERVAL '105 minutes', NOW() - INTERVAL '90 minutes', 10, 'Vitals normal'),
      (v_visit_id, 'with_doctor', NOW() - INTERVAL '90 minutes', NOW() - INTERVAL '20 minutes', 15, 'Doctor ordered tests'),
      (v_visit_id, 'at_lab', NOW() - INTERVAL '10 minutes', NULL, NULL, 'Sample collection pending')
    ON CONFLICT DO NOTHING;
    
    INSERT INTO public.lab_orders (tenant_id, facility_id, visit_id, patient_id, test_name, status, ordering_doctor_id, priority, clinical_notes)
    VALUES 
      (v_tenant_id, v_facility_id, v_visit_id, v_patient_id, 'HbA1c', 'pending', v_doctor_id, 'routine', 'Diabetes follow-up'),
      (v_tenant_id, v_facility_id, v_visit_id, v_patient_id, 'Fasting Blood Sugar', 'pending', v_doctor_id, 'routine', 'Diabetes monitoring'),
      (v_tenant_id, v_facility_id, v_visit_id, v_patient_id, 'Lipid Panel', 'pending', v_doctor_id, 'routine', 'Cardiovascular risk')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Patient 4: At Imaging
  SELECT id INTO v_patient_id FROM public.patients WHERE mrn = 'MRN-DEMO-004' AND tenant_id = v_tenant_id;
  INSERT INTO public.visits (tenant_id, facility_id, patient_id, visit_date, visit_type, status, journey_stage, current_journey_stage, routing_status, chief_complaint, priority, created_at)
  VALUES (v_tenant_id, v_facility_id, v_patient_id, CURRENT_DATE, 'walk_in', 'in_progress', 'at_imaging', 'at_imaging', 'routing_in_progress', 'Chest pain, shortness of breath', 'urgent', NOW() - INTERVAL '80 minutes')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_visit_id;
  
  IF v_visit_id IS NOT NULL AND v_doctor_id IS NOT NULL THEN
    INSERT INTO public.journey_timeline (visit_id, stage, arrived_at, completed_at, wait_time_minutes, notes)
    VALUES 
      (v_visit_id, 'reception', NOW() - INTERVAL '80 minutes', NOW() - INTERVAL '65 minutes', 8, 'Urgent walk-in'),
      (v_visit_id, 'at_triage', NOW() - INTERVAL '65 minutes', NOW() - INTERVAL '50 minutes', 8, 'High priority - chest pain'),
      (v_visit_id, 'with_doctor', NOW() - INTERVAL '50 minutes', NOW() - INTERVAL '30 minutes', 12, 'Chest X-ray ordered'),
      (v_visit_id, 'at_imaging', NOW() - INTERVAL '20 minutes', NULL, NULL, 'Waiting for X-ray')
    ON CONFLICT DO NOTHING;
    
    INSERT INTO public.imaging_orders (tenant_id, facility_id, visit_id, patient_id, study_type, body_part, status, ordering_doctor_id, priority, clinical_indication)
    VALUES (v_tenant_id, v_facility_id, v_visit_id, v_patient_id, 'X-Ray', 'Chest', 'pending', v_doctor_id, 'urgent', 'Rule out pneumonia')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Patient 5: At Pharmacy
  SELECT id INTO v_patient_id FROM public.patients WHERE mrn = 'MRN-DEMO-005' AND tenant_id = v_tenant_id;
  INSERT INTO public.visits (tenant_id, facility_id, patient_id, visit_date, visit_type, status, journey_stage, current_journey_stage, routing_status, chief_complaint, priority, created_at)
  VALUES (v_tenant_id, v_facility_id, v_patient_id, CURRENT_DATE, 'scheduled', 'in_progress', 'at_pharmacy', 'at_pharmacy', 'routing_in_progress', 'Flu symptoms', 'routine', NOW() - INTERVAL '60 minutes')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_visit_id;
  
  IF v_visit_id IS NOT NULL AND v_doctor_id IS NOT NULL THEN
    INSERT INTO public.journey_timeline (visit_id, stage, arrived_at, completed_at, wait_time_minutes, notes)
    VALUES 
      (v_visit_id, 'reception', NOW() - INTERVAL '60 minutes', NOW() - INTERVAL '50 minutes', 6, 'Walk-in patient'),
      (v_visit_id, 'at_triage', NOW() - INTERVAL '50 minutes', NOW() - INTERVAL '40 minutes', 8, 'Mild fever 37.8°C'),
      (v_visit_id, 'with_doctor', NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '15 minutes', 10, 'Prescribed medications'),
      (v_visit_id, 'at_pharmacy', NOW() - INTERVAL '5 minutes', NULL, NULL, 'Dispensing medications')
    ON CONFLICT DO NOTHING;
    
    INSERT INTO public.medication_orders (tenant_id, facility_id, visit_id, patient_id, medication_name, dosage, frequency, duration, status, prescribing_doctor_id)
    VALUES 
      (v_tenant_id, v_facility_id, v_visit_id, v_patient_id, 'Amoxicillin', '500mg', 'TID', '7 days', 'pending', v_doctor_id),
      (v_tenant_id, v_facility_id, v_visit_id, v_patient_id, 'Paracetamol', '1000mg', 'QID PRN', '5 days', 'pending', v_doctor_id)
    ON CONFLICT DO NOTHING;
  END IF;

  -- Patient 6: Paying Consultation
  SELECT id INTO v_patient_id FROM public.patients WHERE mrn = 'MRN-DEMO-006' AND tenant_id = v_tenant_id;
  INSERT INTO public.visits (tenant_id, facility_id, patient_id, visit_date, visit_type, status, journey_stage, current_journey_stage, routing_status, chief_complaint, priority, created_at)
  VALUES (v_tenant_id, v_facility_id, v_patient_id, CURRENT_DATE, 'walk_in', 'in_progress', 'paying_consultation', 'paying_consultation', 'awaiting_routing', 'Annual physical exam', 'routine', NOW() - INTERVAL '30 minutes')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_visit_id;
  
  IF v_visit_id IS NOT NULL THEN
    INSERT INTO public.journey_timeline (visit_id, stage, arrived_at, completed_at, wait_time_minutes, notes)
    VALUES 
      (v_visit_id, 'reception', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '22 minutes', 5, 'Annual checkup'),
      (v_visit_id, 'paying_consultation', NOW() - INTERVAL '8 minutes', NULL, NULL, 'Awaiting payment')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Patient 7: Paying Diagnosis
  SELECT id INTO v_patient_id FROM public.patients WHERE mrn = 'MRN-DEMO-007' AND tenant_id = v_tenant_id;
  INSERT INTO public.visits (tenant_id, facility_id, patient_id, visit_date, visit_type, status, journey_stage, current_journey_stage, routing_status, chief_complaint, priority, created_at)
  VALUES (v_tenant_id, v_facility_id, v_patient_id, CURRENT_DATE, 'scheduled', 'in_progress', 'paying_diagnosis', 'paying_diagnosis', 'awaiting_routing', 'Chronic back pain', 'routine', NOW() - INTERVAL '150 minutes')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_visit_id;
  
  IF v_visit_id IS NOT NULL THEN
    INSERT INTO public.journey_timeline (visit_id, stage, arrived_at, completed_at, wait_time_minutes, notes)
    VALUES 
      (v_visit_id, 'reception', NOW() - INTERVAL '150 minutes', NOW() - INTERVAL '140 minutes', 6, 'Follow-up visit'),
      (v_visit_id, 'at_triage', NOW() - INTERVAL '140 minutes', NOW() - INTERVAL '130 minutes', 8, 'Pain assessment'),
      (v_visit_id, 'with_doctor', NOW() - INTERVAL '130 minutes', NOW() - INTERVAL '90 minutes', 18, 'Ordered lumbar X-ray'),
      (v_visit_id, 'at_imaging', NOW() - INTERVAL '90 minutes', NOW() - INTERVAL '50 minutes', 25, 'X-ray completed'),
      (v_visit_id, 'paying_diagnosis', NOW() - INTERVAL '12 minutes', NULL, NULL, 'Payment pending')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Patient 8: Completed/Discharged
  SELECT id INTO v_patient_id FROM public.patients WHERE mrn = 'MRN-DEMO-008' AND tenant_id = v_tenant_id;
  INSERT INTO public.visits (tenant_id, facility_id, patient_id, visit_date, visit_type, status, journey_stage, current_journey_stage, routing_status, chief_complaint, priority, created_at)
  VALUES (v_tenant_id, v_facility_id, v_patient_id, CURRENT_DATE, 'walk_in', 'completed', 'discharged', 'discharged', NULL, 'Minor injury - wound dressing', 'routine', NOW() - INTERVAL '180 minutes')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_visit_id;
  
  IF v_visit_id IS NOT NULL THEN
    INSERT INTO public.journey_timeline (visit_id, stage, arrived_at, completed_at, wait_time_minutes, notes)
    VALUES 
      (v_visit_id, 'reception', NOW() - INTERVAL '180 minutes', NOW() - INTERVAL '170 minutes', 5, 'Minor injury'),
      (v_visit_id, 'at_triage', NOW() - INTERVAL '170 minutes', NOW() - INTERVAL '160 minutes', 8, 'Wound assessment'),
      (v_visit_id, 'with_doctor', NOW() - INTERVAL '160 minutes', NOW() - INTERVAL '120 minutes', 15, 'Wound cleaned'),
      (v_visit_id, 'at_pharmacy', NOW() - INTERVAL '120 minutes', NOW() - INTERVAL '100 minutes', 10, 'Tetanus shot'),
      (v_visit_id, 'discharged', NOW() - INTERVAL '100 minutes', NOW() - INTERVAL '95 minutes', 5, 'Discharged')
    ON CONFLICT DO NOTHING;
  END IF;

  RAISE NOTICE 'Demo patient journey data seeded successfully!';
END $$;

-- Show results
SELECT 
  'Demo Data Summary' AS info,
  (SELECT COUNT(*) FROM patients WHERE mrn LIKE 'MRN-DEMO-%') AS demo_patients,
  (SELECT COUNT(*) FROM visits v JOIN patients p ON v.patient_id = p.id WHERE p.mrn LIKE 'MRN-DEMO-%') AS demo_visits;
