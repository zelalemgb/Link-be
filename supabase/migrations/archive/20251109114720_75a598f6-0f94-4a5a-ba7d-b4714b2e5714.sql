-- Create sample inpatient records for current logged-in doctor (route fixed)
DO $$
DECLARE 
  v_doctor_id uuid := 'e69e17c6-1309-4f07-913c-6ce5b59fe49c';
  v_facility_id uuid;
  v_tenant_id uuid;
  v_patient_id uuid;
  v_visit_id uuid;
  i INT;
BEGIN
  -- Get doctor's facility and tenant
  SELECT facility_id, tenant_id INTO v_facility_id, v_tenant_id 
  FROM users WHERE id = v_doctor_id;
  
  -- Create 5 test inpatients
  FOR i IN 1..5 LOOP
    -- Create patient
    INSERT INTO patients (
      tenant_id, facility_id, created_by, 
      full_name, first_name, last_name, 
      gender, age, phone
    )
    VALUES (
      v_tenant_id, v_facility_id, v_doctor_id, 
      'Test Inpatient ' || i, 'Test', 'Inpatient' || i,
      CASE WHEN i % 2 = 0 THEN 'Female' ELSE 'Male' END, 
      25 + (i * 8), 
      '+251911' || LPAD(i::text, 6, '0')
    )
    RETURNING id INTO v_patient_id;
    
    -- Create admitted visit
    INSERT INTO visits (
      tenant_id, facility_id, patient_id, 
      created_by, provider, visit_date, 
      reason, status, 
      admission_ward, admission_bed, 
      admitted_at, assigned_doctor, 
      fee_paid
    )
    VALUES (
      v_tenant_id, v_facility_id, v_patient_id, 
      v_doctor_id, 'Clinical Assessment', CURRENT_DATE - (i % 3),
      CASE i 
        WHEN 1 THEN 'Severe pneumonia with respiratory distress'
        WHEN 2 THEN 'Post-operative monitoring after appendectomy'
        WHEN 3 THEN 'Uncontrolled diabetes with DKA'
        WHEN 4 THEN 'Severe malaria with complications'
        ELSE 'Acute heart failure requiring intensive monitoring'
      END,
      'admitted', 
      CASE WHEN i <= 3 THEN 'Medical Ward A' ELSE 'Pediatric Ward' END, 
      'B-' || (100 + i)::text,
      NOW() - (i * 24 || ' hours')::interval, 
      v_doctor_id, 
      200.00
    )
    RETURNING id INTO v_visit_id;
    
    -- Add medication order per patient (oral route)
    INSERT INTO medication_orders (
      tenant_id, visit_id, patient_id, ordered_by,
      medication_name, generic_name, 
      dosage, frequency, route, duration, 
      status, quantity, ordered_at, 
      payment_status, amount
    )
    VALUES 
    (
      v_tenant_id, v_visit_id, v_patient_id, v_doctor_id,
      CASE i % 4 
        WHEN 0 THEN 'Ceftriaxone 1g'
        WHEN 1 THEN 'Insulin Regular'
        WHEN 2 THEN 'Artesunate'
        ELSE 'Furosemide 40mg'
      END,
      CASE i % 4 
        WHEN 0 THEN 'Ceftriaxone'
        WHEN 1 THEN 'Insulin'
        WHEN 2 THEN 'Artesunate'
        ELSE 'Furosemide'
      END,
      CASE i % 4 
        WHEN 0 THEN '1g'
        WHEN 1 THEN '10 units'
        WHEN 2 THEN '120mg'
        ELSE '40mg'
      END,
      CASE i % 3 
        WHEN 0 THEN 'BID'
        WHEN 1 THEN 'TID'
        ELSE 'QID'
      END,
      'oral',
      '7 days', 
      'pending', 
      14,
      NOW() - (i * 2 || ' hours')::interval, 
      'paid',
      150.00
    );
    
    -- Add lab orders for first 3 patients
    IF i <= 3 THEN
      INSERT INTO lab_orders (
        tenant_id, visit_id, patient_id, ordered_by,
        test_name, test_code, urgency, 
        status, ordered_at, 
        payment_status, amount
      )
      VALUES (
        v_tenant_id, v_visit_id, v_patient_id, v_doctor_id,
        CASE WHEN i = 1 THEN 'Complete Blood Count' 
             WHEN i = 2 THEN 'Fasting Blood Sugar' 
             ELSE 'Blood Film for Malaria' 
        END,
        CASE WHEN i = 1 THEN 'CBC' 
             WHEN i = 2 THEN 'FBS' 
             ELSE 'BF-MP' 
        END,
        CASE WHEN i = 1 THEN 'stat' ELSE 'routine' END, 
        'pending', 
        NOW() - (i * 4 || ' hours')::interval, 
        'paid', 
        180.00
      );
    END IF;
  END LOOP;
  
  RAISE NOTICE 'Created 5 test inpatients for doctor % in facility %', v_doctor_id, v_facility_id;
END $$;
