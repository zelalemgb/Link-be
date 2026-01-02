-- Sample master data seed for testing clinics.
-- Includes: medical services with pricing, departments, wards, insurers, suppliers, programs.
-- Uses the current user's facility or first facility as fallback.

WITH ctx AS (
  SELECT 
    COALESCE(get_user_facility_id(), (SELECT id FROM public.facilities ORDER BY created_at LIMIT 1)) AS facility_id,
    COALESCE(get_user_tenant_id(), (SELECT id FROM public.tenants ORDER BY created_at LIMIT 1)) AS tenant_id,
    COALESCE(auth.uid(), (SELECT auth_user_id FROM public.users ORDER BY created_at LIMIT 1)) AS user_id
),
user_record AS (
  SELECT id FROM public.users WHERE auth_user_id = (SELECT user_id FROM ctx) LIMIT 1
),

-- Insert Departments
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
    ('Internal Medicine', 'IM', 'inpatient', 'Ward Block', '1st Floor', true),
    ('Pediatrics', 'PED', 'inpatient', 'Ward Block', '2nd Floor', true),
    ('Obstetrics & Gynecology', 'OBGYN', 'inpatient', 'Maternity Wing', '1st Floor', true),
    ('Surgery', 'SURG', 'inpatient', 'Surgical Block', '1st Floor', true),
    ('Laboratory', 'LAB', 'ancillary', 'Main Building', 'Ground', false),
    ('Pharmacy', 'PHARM', 'ancillary', 'Main Building', 'Ground', false),
    ('Radiology', 'RAD', 'ancillary', 'Main Building', 'Basement', false),
    ('Antenatal Care', 'ANC', 'outpatient', 'Maternity Wing', 'Ground', false)
  ) AS v(name, code, department_type, building, floor, accepts_admissions)
  ON CONFLICT DO NOTHING
  RETURNING id, code
),

-- Insert Wards linked to departments
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
    ('Pediatric Ward', 'PED-W', 'PED', 'pediatric', 'mixed', 15),
    ('Maternity Ward', 'MAT-W', 'OBGYN', 'maternity', 'female', 12),
    ('Surgical Ward', 'SURG-W', 'SURG', 'surgical', 'mixed', 16),
    ('ICU', 'ICU', 'IM', 'icu', 'mixed', 6),
    ('Emergency Observation', 'ED-OBS', 'ED', 'observation', 'mixed', 8)
  ) AS w(ward_name, ward_code, dept_code, ward_type, gender, total_beds)
  LEFT JOIN public.departments d ON d.code = w.dept_code AND d.facility_id = ctx.facility_id
  WHERE d.id IS NOT NULL
  ON CONFLICT DO NOTHING
  RETURNING id
),

-- Insert Medical Services with pricing
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
    -- Consultation Services
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
    
    -- Laboratory Services
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
    
    -- Imaging Services
    ('X-Ray Chest PA', 'Imaging', 200.00, 'Chest X-ray posteroanterior view', NULL, NULL),
    ('X-Ray Abdomen', 'Imaging', 250.00, 'Abdominal X-ray', NULL, NULL),
    ('X-Ray Extremity', 'Imaging', 180.00, 'X-ray of arm, leg, hand, or foot', NULL, NULL),
    ('X-Ray Spine', 'Imaging', 300.00, 'Spinal X-ray (cervical/thoracic/lumbar)', NULL, NULL),
    ('Ultrasound Abdomen', 'Imaging', 400.00, 'Abdominal ultrasound', NULL, NULL),
    ('Ultrasound Pelvis', 'Imaging', 350.00, 'Pelvic ultrasound', NULL, NULL),
    ('Ultrasound Obstetric', 'Imaging', 400.00, 'Obstetric ultrasound', NULL, NULL),
    ('Ultrasound Thyroid', 'Imaging', 350.00, 'Thyroid ultrasound', NULL, NULL),
    
    -- Admission Services
    ('Ward Bed - General', 'Admission', 500.00, 'General ward bed per day', NULL, NULL),
    ('Ward Bed - Private', 'Admission', 1200.00, 'Private room per day', NULL, NULL),
    ('ICU Bed', 'Admission', 3000.00, 'Intensive care unit bed per day', NULL, NULL),
    ('Nursing Care', 'Admission', 300.00, 'Daily nursing care charge', NULL, NULL),
    ('Operating Theatre - Minor', 'Admission', 2000.00, 'Minor surgery theatre fee', NULL, NULL),
    ('Operating Theatre - Major', 'Admission', 5000.00, 'Major surgery theatre fee', NULL, NULL),
    
    -- Other Services
    ('Medical Certificate', 'Other', 100.00, 'Fitness/sick leave certificate', NULL, NULL),
    ('Medical Report', 'Other', 300.00, 'Detailed medical report', NULL, NULL),
    ('Ambulance Service - Local', 'Other', 500.00, 'Local ambulance transport', NULL, NULL),
    ('Ambulance Service - Referral', 'Other', 2000.00, 'Inter-facility ambulance transfer', NULL, NULL)
  ) AS v(name, category, price, description, follow_up_price, follow_up_days)
  ON CONFLICT DO NOTHING
  RETURNING id
),

-- Insert Insurers
insert_insurers AS (
  INSERT INTO public.insurers (
    facility_id, tenant_id, name, code, contact_email, contact_phone,
    discount_percentage, is_active, created_by
  )
  SELECT
    ctx.facility_id, ctx.tenant_id,
    v.name, v.code, v.email, v.phone, v.discount, true, u.id
  FROM ctx
  CROSS JOIN user_record u
  CROSS JOIN (VALUES
    ('Ethiopian Health Insurance Agency', 'EHIA', 'claims@ehia.gov.et', '+251115571234', 0),
    ('Community Based Health Insurance', 'CBHI', 'cbhi@health.gov.et', '+251115572345', 0),
    ('Nyala Insurance', 'NYALA', 'health@nyalainsurance.com', '+251115513456', 5),
    ('Awash Insurance', 'AWASH', 'medical@awashinsurance.com', '+251115514567', 5),
    ('Ethiopian Insurance Corporation', 'EIC', 'claims@eic.com.et', '+251115515678', 10),
    ('United Insurance', 'UNITED', 'health@unitedinsurance.et', '+251115516789', 5),
    ('Africa Insurance', 'AFRICA', 'claims@africainsurance.et', '+251115517890', 5),
    ('Oromia Insurance', 'OIC', 'medical@oromiainsurance.com', '+251115518901', 5)
  ) AS v(name, code, email, phone, discount)
  ON CONFLICT DO NOTHING
  RETURNING id
),

-- Insert Suppliers
insert_suppliers AS (
  INSERT INTO public.suppliers (
    facility_id, name, contact_person, phone, email, address, is_active, created_by
  )
  SELECT
    ctx.facility_id,
    v.name, v.contact, v.phone, v.email, v.address, true, u.id
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

-- Insert Programs (free programs offered)
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
  'Master data seed completed' AS status,
  (SELECT count(*) FROM insert_departments) AS departments_inserted,
  (SELECT count(*) FROM insert_wards) AS wards_inserted,
  (SELECT count(*) FROM insert_services) AS services_inserted,
  (SELECT count(*) FROM insert_insurers) AS insurers_inserted,
  (SELECT count(*) FROM insert_suppliers) AS suppliers_inserted,
  (SELECT count(*) FROM insert_programs) AS programs_inserted;

-- Verify with:
-- SELECT category, count(*), min(price), max(price) FROM medical_services GROUP BY category ORDER BY category;
