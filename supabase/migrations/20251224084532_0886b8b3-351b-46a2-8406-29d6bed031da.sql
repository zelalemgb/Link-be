-- Seed master data for Opian Health care Center (idempotent)

WITH ctx AS (
  SELECT
    '23e60de7-16f3-4789-a99b-61de613caa9b'::uuid AS facility_id,
    '00000000-0000-0000-0000-000000000001'::uuid AS tenant_id
),
user_record AS (
  SELECT u.id
  FROM public.users u
  JOIN ctx ON u.tenant_id = ctx.tenant_id
  ORDER BY u.created_at
  LIMIT 1
),

-- Departments (mapped to allowed department_type values)
insert_departments AS (
  INSERT INTO public.departments (
    facility_id, tenant_id, name, code, department_type, is_active,
    location_building, location_floor, accepts_admissions
  )
  SELECT
    ctx.facility_id, ctx.tenant_id,
    v.name, v.code, v.department_type, true,
    v.building, v.floor, v.accepts_admissions
  FROM ctx
  CROSS JOIN (VALUES
    ('General Outpatient', 'OPD', 'outpatient', 'Main Building', 'Ground', false),
    ('Emergency', 'ED', 'emergency', 'Main Building', 'Ground', true),
    ('Internal Medicine', 'IM', 'medical', 'Ward Block', '1st Floor', true),
    ('Pediatrics', 'PED', 'pediatric', 'Ward Block', '2nd Floor', true),
    ('Obstetrics & Gynecology', 'OBGYN', 'maternity', 'Maternity Wing', '1st Floor', true),
    ('Surgery', 'SURG', 'surgical', 'Surgical Block', '1st Floor', true),
    ('Laboratory', 'LAB', 'medical', 'Main Building', 'Ground', false),
    ('Pharmacy', 'PHARM', 'medical', 'Main Building', 'Ground', false),
    ('Radiology', 'RAD', 'medical', 'Main Building', 'Basement', false),
    ('Antenatal Care', 'ANC', 'outpatient', 'Maternity Wing', 'Ground', false)
  ) AS v(name, code, department_type, building, floor, accepts_admissions)
  ON CONFLICT DO NOTHING
  RETURNING id, code
),

-- Wards (mapped to allowed ward_type / gender_restriction values)
insert_wards AS (
  INSERT INTO public.wards (
    facility_id, tenant_id, name, code, department_id,
    ward_type, gender_restriction, total_beds, available_beds, is_active
  )
  SELECT
    ctx.facility_id, ctx.tenant_id,
    w.ward_name, w.ward_code,
    d.id,
    w.ward_type, w.gender, w.total_beds, w.total_beds, true
  FROM ctx
  CROSS JOIN (VALUES
    ('Medical Ward A', 'MED-A', 'IM', 'general', 'male', 20),
    ('Medical Ward B', 'MED-B', 'IM', 'general', 'female', 20),
    ('Pediatric Ward', 'PED-W', 'PED', 'general', 'pediatric', 15),
    ('Maternity Ward', 'MAT-W', 'OBGYN', 'general', 'female', 12),
    ('Surgical Ward', 'SURG-W', 'SURG', 'general', 'mixed', 16),
    ('ICU', 'ICU', 'IM', 'observation', 'mixed', 6),
    ('Emergency Observation', 'ED-OBS', 'ED', 'observation', 'mixed', 8)
  ) AS w(ward_name, ward_code, dept_code, ward_type, gender, total_beds)
  LEFT JOIN public.departments d
    ON d.code = w.dept_code
   AND d.facility_id = ctx.facility_id
   AND d.tenant_id = ctx.tenant_id
  WHERE d.id IS NOT NULL
  ON CONFLICT DO NOTHING
  RETURNING id
),

-- Medical services (schema-aligned)
insert_services AS (
  INSERT INTO public.medical_services (
    facility_id, tenant_id, name, category, price, description,
    follow_up_price, follow_up_days, is_active, created_by
  )
  SELECT
    ctx.facility_id, ctx.tenant_id,
    v.name, v.category, v.price, v.description,
    v.follow_up_price, v.follow_up_days, true,
    u.id
  FROM ctx
  CROSS JOIN user_record u
  CROSS JOIN (VALUES
    -- Consultation
    ('General Consultation', 'Consultation', 150.00, 'Initial consultation with general practitioner', 75.00, 7),
    ('Specialist Consultation', 'Consultation', 300.00, 'Consultation with specialist physician', 150.00, 14),
    ('Pediatric Consultation', 'Consultation', 180.00, 'Consultation for children under 18', 90.00, 7),
    ('Emergency Consultation', 'Consultation', 250.00, 'Emergency room physician consultation', NULL, NULL),
    ('Follow-up Visit', 'Consultation', 100.00, 'Follow-up visit within valid period', NULL, NULL),
    ('Antenatal Visit', 'Consultation', 200.00, 'Routine antenatal care visit', 100.00, 30),
    ('Postnatal Visit', 'Consultation', 180.00, 'Postpartum checkup visit', 90.00, 14),

    -- Procedures
    ('Minor Wound Dressing', 'Procedure', 80.00, 'Simple wound cleaning and dressing', NULL, NULL),
    ('Major Wound Dressing', 'Procedure', 200.00, 'Complex wound care and dressing', NULL, NULL),
    ('IV Cannulation', 'Procedure', 100.00, 'Intravenous line insertion', NULL, NULL),
    ('Catheterization', 'Procedure', 150.00, 'Urinary catheter insertion', NULL, NULL),
    ('Injection Administration', 'Procedure', 50.00, 'Intramuscular or subcutaneous injection', NULL, NULL),
    ('Nebulization', 'Procedure', 80.00, 'Respiratory nebulizer treatment', NULL, NULL),
    ('ECG', 'Procedure', 200.00, 'Electrocardiogram recording', NULL, NULL),
    ('Suturing - Simple', 'Procedure', 300.00, 'Simple laceration repair (up to 5cm)', NULL, NULL),
    ('Suturing - Complex', 'Procedure', 600.00, 'Complex laceration repair', NULL, NULL),
    ('Incision & Drainage', 'Procedure', 500.00, 'Abscess incision and drainage', NULL, NULL),
    ('Circumcision', 'Procedure', 1500.00, 'Male circumcision procedure', NULL, NULL),
    ('Normal Delivery', 'Procedure', 5000.00, 'Spontaneous vaginal delivery', NULL, NULL),
    ('Cesarean Section', 'Procedure', 15000.00, 'Cesarean delivery', NULL, NULL),

    -- Laboratory
    ('Complete Blood Count', 'Laboratory', 120.00, 'CBC with differential', NULL, NULL),
    ('Blood Glucose - Fasting', 'Laboratory', 60.00, 'Fasting blood sugar test', NULL, NULL),
    ('Blood Glucose - Random', 'Laboratory', 60.00, 'Random blood sugar test', NULL, NULL),
    ('Urinalysis', 'Laboratory', 50.00, 'Complete urine analysis', NULL, NULL),
    ('Stool Examination', 'Laboratory', 50.00, 'Stool microscopy and occult blood', NULL, NULL),
    ('Malaria Rapid Test', 'Laboratory', 80.00, 'Rapid diagnostic test for malaria', NULL, NULL),
    ('Malaria Blood Film', 'Laboratory', 100.00, 'Peripheral blood smear for malaria', NULL, NULL),
    ('HIV Rapid Test', 'Laboratory', 150.00, 'HIV antibody rapid test', NULL, NULL),
    ('Hepatitis B Surface Antigen', 'Laboratory', 200.00, 'HBsAg test', NULL, NULL),
    ('Hepatitis C Antibody', 'Laboratory', 200.00, 'Anti-HCV test', NULL, NULL),
    ('VDRL/RPR', 'Laboratory', 150.00, 'Syphilis screening test', NULL, NULL),
    ('Pregnancy Test', 'Laboratory', 80.00, 'Urine or serum beta-hCG', NULL, NULL),
    ('Blood Group & Rh', 'Laboratory', 100.00, 'ABO and Rh typing', NULL, NULL),
    ('Cross Match', 'Laboratory', 200.00, 'Blood compatibility testing', NULL, NULL),
    ('Lipid Profile', 'Laboratory', 300.00, 'Total cholesterol, HDL, LDL, triglycerides', NULL, NULL),
    ('Liver Function Tests', 'Laboratory', 350.00, 'ALT, AST, ALP, bilirubin, albumin', NULL, NULL),
    ('Renal Function Tests', 'Laboratory', 300.00, 'Creatinine, BUN, electrolytes', NULL, NULL),
    ('Thyroid Function Tests', 'Laboratory', 400.00, 'TSH, T3, T4', NULL, NULL),
    ('Widal Test', 'Laboratory', 150.00, 'Typhoid fever serology', NULL, NULL),
    ('ESR', 'Laboratory', 60.00, 'Erythrocyte sedimentation rate', NULL, NULL),
    ('Blood Culture', 'Laboratory', 400.00, 'Aerobic blood culture', NULL, NULL),
    ('Urine Culture', 'Laboratory', 350.00, 'Urine culture and sensitivity', NULL, NULL),

    -- Imaging
    ('X-Ray Chest PA', 'Imaging', 200.00, 'Chest X-ray posteroanterior view', NULL, NULL),
    ('X-Ray Abdomen', 'Imaging', 250.00, 'Abdominal X-ray', NULL, NULL),
    ('X-Ray Extremity', 'Imaging', 180.00, 'X-ray of arm, leg, hand, or foot', NULL, NULL),
    ('X-Ray Spine', 'Imaging', 300.00, 'Spinal X-ray (cervical/thoracic/lumbar)', NULL, NULL),
    ('Ultrasound Abdomen', 'Imaging', 400.00, 'Abdominal ultrasound', NULL, NULL),
    ('Ultrasound Pelvis', 'Imaging', 350.00, 'Pelvic ultrasound', NULL, NULL),
    ('Ultrasound Obstetric', 'Imaging', 400.00, 'Obstetric ultrasound', NULL, NULL),
    ('Ultrasound Thyroid', 'Imaging', 350.00, 'Thyroid ultrasound', NULL, NULL),

    -- Admission
    ('Ward Bed - General', 'Admission', 500.00, 'General ward bed per day', NULL, NULL),
    ('Ward Bed - Private', 'Admission', 1200.00, 'Private room per day', NULL, NULL),
    ('ICU Bed', 'Admission', 3000.00, 'Intensive care unit bed per day', NULL, NULL),
    ('Nursing Care', 'Admission', 300.00, 'Daily nursing care charge', NULL, NULL),
    ('Operating Theatre - Minor', 'Admission', 2000.00, 'Minor surgery theatre fee', NULL, NULL),
    ('Operating Theatre - Major', 'Admission', 5000.00, 'Major surgery theatre fee', NULL, NULL),

    -- Other
    ('Medical Certificate', 'Other', 100.00, 'Fitness/sick leave certificate', NULL, NULL),
    ('Medical Report', 'Other', 300.00, 'Detailed medical report', NULL, NULL),
    ('Ambulance Service - Local', 'Other', 500.00, 'Local ambulance transport', NULL, NULL),
    ('Ambulance Service - Referral', 'Other', 2000.00, 'Inter-facility ambulance transfer', NULL, NULL)
  ) AS v(name, category, price, description, follow_up_price, follow_up_days)
  ON CONFLICT DO NOTHING
  RETURNING id
),

-- Insurers (schema-aligned)
insert_insurers AS (
  INSERT INTO public.insurers (
    facility_id, tenant_id, name, code, is_active, created_by
  )
  SELECT
    ctx.facility_id, ctx.tenant_id,
    v.name, v.code, true, u.id
  FROM ctx
  CROSS JOIN user_record u
  CROSS JOIN (VALUES
    ('Ethiopian Health Insurance Agency', 'EHIA'),
    ('Community Based Health Insurance', 'CBHI'),
    ('Nyala Insurance', 'NYALA'),
    ('Awash Insurance', 'AWASH'),
    ('Ethiopian Insurance Corporation', 'EIC'),
    ('United Insurance', 'UNITED'),
    ('Africa Insurance', 'AFRICA'),
    ('Oromia Insurance', 'OIC')
  ) AS v(name, code)
  ON CONFLICT DO NOTHING
  RETURNING id
),

-- Suppliers (schema-aligned: includes tenant_id)
insert_suppliers AS (
  INSERT INTO public.suppliers (
    facility_id, tenant_id, name, contact_person, phone, email, address,
    is_active, created_by
  )
  SELECT
    ctx.facility_id, ctx.tenant_id,
    v.name, v.contact, v.phone, v.email, v.address,
    true, u.id
  FROM ctx
  CROSS JOIN user_record u
  CROSS JOIN (VALUES
    ('Ethiopian Pharmaceuticals Manufacturing', 'Abebe Tadesse', '+251911234567', 'sales@epharm.com.et', 'Addis Ababa, Ethiopia'),
    ('PHARMID', 'Sara Mekonnen', '+251912345678', 'orders@pharmid.et', 'Addis Ababa, Ethiopia'),
    ('Cadila Pharmaceuticals Ethiopia', 'Yohannes Girma', '+251913456789', 'ethiopia@cadila.com', 'Addis Ababa, Ethiopia'),
    ('Julphar Ethiopia', 'Meron Hailu', '+251914567890', 'orders@julphar.et', 'Addis Ababa, Ethiopia'),
    ('MedTech Supplies', 'Daniel Kebede', '+251915678901', 'sales@medtech.et', 'Addis Ababa, Ethiopia'),
    ('LabEquip Ethiopia', 'Tigist Alemu', '+251916789012', 'orders@labequip.et', 'Addis Ababa, Ethiopia'),
    ('SurgiMed Imports', 'Bekele Worku', '+251917890123', 'info@surgimed.et', 'Addis Ababa, Ethiopia')
  ) AS v(name, contact, phone, email, address)
  ON CONFLICT DO NOTHING
  RETURNING id
),

-- Programs
insert_programs AS (
  INSERT INTO public.programs (
    facility_id, tenant_id, name, code, is_active, created_by
  )
  SELECT
    ctx.facility_id, ctx.tenant_id,
    v.name, v.code, true, u.id
  FROM ctx
  CROSS JOIN user_record u
  CROSS JOIN (VALUES
    ('HIV/AIDS Prevention and Treatment', 'HIV'),
    ('Tuberculosis Control Program', 'TB'),
    ('Malaria Prevention Program', 'MALARIA'),
    ('Expanded Program on Immunization', 'EPI'),
    ('Family Planning Services', 'FP'),
    ('Antenatal Care Program', 'ANC'),
    ('Nutrition Program', 'NUTRITION'),
    ('Non-Communicable Diseases', 'NCD'),
    ('Mental Health Services', 'MENTAL')
  ) AS v(name, code)
  ON CONFLICT DO NOTHING
  RETURNING id
)

SELECT
  'Opian master data seed completed' AS status,
  (SELECT count(*) FROM insert_departments) AS departments_inserted,
  (SELECT count(*) FROM insert_wards) AS wards_inserted,
  (SELECT count(*) FROM insert_services) AS services_inserted,
  (SELECT count(*) FROM insert_insurers) AS insurers_inserted,
  (SELECT count(*) FROM insert_suppliers) AS suppliers_inserted,
  (SELECT count(*) FROM insert_programs) AS programs_inserted;
