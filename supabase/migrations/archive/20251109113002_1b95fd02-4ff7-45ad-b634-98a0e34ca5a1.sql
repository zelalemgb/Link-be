-- Create test department
INSERT INTO departments (tenant_id, facility_id, name, code, department_type, is_active, accepts_admissions)
SELECT u.tenant_id, u.facility_id, 'General Medicine', 'GM', 'medical', true, true
FROM users u
WHERE u.id = '399f169f-febb-4a7c-a314-c34154833aa0'
  AND NOT EXISTS (SELECT 1 FROM departments WHERE name = 'General Medicine' AND facility_id = u.facility_id);

-- Create wards
INSERT INTO wards (tenant_id, facility_id, department_id, name, code, total_beds, available_beds, occupied_beds, cleaning_beds, is_active, accepts_admissions)
SELECT u.tenant_id, u.facility_id, d.id, 'Medical Ward A', 'MED-A', 10, 5, 3, 2, true, true
FROM users u CROSS JOIN departments d
WHERE u.id = '399f169f-febb-4a7c-a314-c34154833aa0' AND d.facility_id = u.facility_id AND d.name = 'General Medicine'
  AND NOT EXISTS (SELECT 1 FROM wards WHERE name = 'Medical Ward A' AND facility_id = u.facility_id);

INSERT INTO wards (tenant_id, facility_id, department_id, name, code, total_beds, available_beds, occupied_beds, cleaning_beds, is_active, accepts_admissions)
SELECT u.tenant_id, u.facility_id, d.id, 'Pediatric Ward', 'PED-1', 8, 3, 4, 1, true, true
FROM users u CROSS JOIN departments d
WHERE u.id = '399f169f-febb-4a7c-a314-c34154833aa0' AND d.facility_id = u.facility_id AND d.name = 'General Medicine'
  AND NOT EXISTS (SELECT 1 FROM wards WHERE name = 'Pediatric Ward' AND facility_id = u.facility_id);

-- Create test inpatients
DO $$
DECLARE v_doctor_id uuid := '399f169f-febb-4a7c-a314-c34154833aa0'; v_facility_id uuid; v_tenant_id uuid; v_patient_id uuid; v_visit_id uuid; i INT;
BEGIN
  SELECT facility_id, tenant_id INTO v_facility_id, v_tenant_id FROM users WHERE id = v_doctor_id;
  FOR i IN 1..5 LOOP
    INSERT INTO patients (tenant_id, facility_id, created_by, full_name, first_name, last_name, gender, age, phone)
    VALUES (v_tenant_id, v_facility_id, v_doctor_id, 'Test Inpatient ' || i, 'Test', 'Inpatient' || i,
            CASE WHEN i % 2 = 0 THEN 'Female' ELSE 'Male' END, 25 + (i * 5), '+251' || (900000000 + i)::text)
    RETURNING id INTO v_patient_id;
    
    INSERT INTO visits (tenant_id, facility_id, patient_id, created_by, provider, visit_date, reason, status, 
                        admission_ward, admission_bed, admitted_at, assigned_doctor, fee_paid)
    VALUES (v_tenant_id, v_facility_id, v_patient_id, v_doctor_id, 'Dr. Alemu taye', CURRENT_DATE,
            CASE i WHEN 1 THEN 'Pneumonia' WHEN 2 THEN 'Post-surgical' WHEN 3 THEN 'Diabetes' WHEN 4 THEN 'Malaria' ELSE 'Observation' END,
            'admitted', CASE WHEN i % 2 = 0 THEN 'Medical Ward A' ELSE 'Pediatric Ward' END, i::text,
            NOW() - (i || ' days')::interval, v_doctor_id, 50)
    RETURNING id INTO v_visit_id;
    
    INSERT INTO medication_orders (tenant_id, visit_id, patient_id, ordered_by, medication_name, generic_name, 
                                    dosage, frequency, route, duration, status, quantity, ordered_at, payment_status)
    VALUES (v_tenant_id, v_visit_id, v_patient_id, v_doctor_id,
            CASE i % 3 WHEN 0 THEN 'Amoxicillin' WHEN 1 THEN 'Paracetamol' ELSE 'Ciprofloxacin' END,
            CASE i % 3 WHEN 0 THEN 'Amoxicillin' WHEN 1 THEN 'Acetaminophen' ELSE 'Ciprofloxacin' END,
            CASE i % 3 WHEN 0 THEN '500mg' WHEN 1 THEN '500mg' ELSE '250mg' END,
            CASE i % 3 WHEN 0 THEN 'TID' WHEN 1 THEN 'Q6H' ELSE 'BID' END,
            'oral', '5 days', 'pending', 30,
            NOW() - (i * 2 || ' hours')::interval, 'paid');
    
    IF i <= 3 THEN
      INSERT INTO lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name, test_code, urgency, status, ordered_at, payment_status, amount)
      VALUES (v_tenant_id, v_visit_id, v_patient_id, v_doctor_id,
              CASE WHEN i % 2 = 0 THEN 'CBC' ELSE 'FBS' END, CASE WHEN i % 2 = 0 THEN 'CBC' ELSE 'FBS' END,
              CASE WHEN i % 3 = 0 THEN 'stat' ELSE 'routine' END, 'pending', NOW() - (i * 3 || ' hours')::interval, 'paid', 150.00);
    END IF;
  END LOOP;
END $$;