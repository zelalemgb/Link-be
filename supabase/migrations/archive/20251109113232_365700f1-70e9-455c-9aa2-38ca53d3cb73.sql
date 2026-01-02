-- Create test inpatients for current logged-in doctor (Clinical Assessment)
DO $$
DECLARE 
  v_doctor_id uuid := 'e69e17c6-1309-4f07-913c-6ce5b59fe49c';
  v_facility_id uuid;
  v_tenant_id uuid;
  v_patient_id uuid;
  v_visit_id uuid;
  i INT;
BEGIN
  SELECT facility_id, tenant_id INTO v_facility_id, v_tenant_id FROM users WHERE id = v_doctor_id;
  
  FOR i IN 1..5 LOOP
    INSERT INTO patients (tenant_id, facility_id, created_by, full_name, first_name, last_name, gender, age, phone)
    VALUES (v_tenant_id, v_facility_id, v_doctor_id, 
            'Inpatient Test ' || i, 'Inpatient', 'Test' || i,
            CASE WHEN i % 2 = 0 THEN 'Female' ELSE 'Male' END, 
            30 + (i * 5), 
            '+251' || (910000000 + i)::text)
    RETURNING id INTO v_patient_id;
    
    INSERT INTO visits (tenant_id, facility_id, patient_id, created_by, provider, visit_date, reason, status, 
                        admission_ward, admission_bed, admitted_at, assigned_doctor, fee_paid)
    VALUES (v_tenant_id, v_facility_id, v_patient_id, v_doctor_id, 
            'Clinical Assessment', 
            CURRENT_DATE,
            CASE i 
              WHEN 1 THEN 'Severe pneumonia requiring observation'
              WHEN 2 THEN 'Post-operative recovery'
              WHEN 3 THEN 'Uncontrolled diabetes'
              WHEN 4 THEN 'Complicated malaria'
              ELSE 'ICU monitoring required'
            END,
            'admitted', 
            CASE WHEN i <= 3 THEN 'Medical Ward A' ELSE 'Pediatric Ward' END, 
            (10 + i)::text,
            NOW() - (i || ' days')::interval, 
            v_doctor_id, 
            200)
    RETURNING id INTO v_visit_id;
    
    -- Add medication orders
    INSERT INTO medication_orders (tenant_id, visit_id, patient_id, ordered_by, medication_name, generic_name, 
                                    dosage, frequency, route, duration, status, quantity, ordered_at, payment_status)
    VALUES (v_tenant_id, v_visit_id, v_patient_id, v_doctor_id,
            CASE i % 3 WHEN 0 THEN 'Ceftriaxone' WHEN 1 THEN 'Insulin' ELSE 'Metronidazole' END,
            CASE i % 3 WHEN 0 THEN 'Ceftriaxone' WHEN 1 THEN 'Insulin' ELSE 'Metronidazole' END,
            CASE i % 3 WHEN 0 THEN '1g' WHEN 1 THEN '10 units' ELSE '500mg' END,
            CASE i % 3 WHEN 0 THEN 'BID' WHEN 1 THEN 'TID' ELSE 'TID' END,
            'oral', 
            '7 days', 
            'pending', 
            42,
            NOW() - (i * 2 || ' hours')::interval, 
            'paid');
    
    -- Add lab orders for first 3 patients
    IF i <= 3 THEN
      INSERT INTO lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name, test_code, urgency, status, ordered_at, payment_status, amount)
      VALUES (v_tenant_id, v_visit_id, v_patient_id, v_doctor_id,
              CASE WHEN i = 1 THEN 'Complete Blood Count' 
                   WHEN i = 2 THEN 'Blood Glucose' 
                   ELSE 'Malaria Test' END,
              CASE WHEN i = 1 THEN 'CBC' 
                   WHEN i = 2 THEN 'FBS' 
                   ELSE 'MP' END,
              CASE WHEN i = 1 THEN 'stat' ELSE 'routine' END, 
              'pending', 
              NOW() - (i * 3 || ' hours')::interval, 
              'paid', 
              200.00);
    END IF;
  END LOOP;
END $$;