-- Populate programs table with common donor programs
-- These programs are typically provided for free by donors/government

-- Insert default programs for all existing facilities
INSERT INTO public.programs (name, code, is_active, facility_id, tenant_id, created_at, updated_at)
SELECT 
  prog.name,
  prog.code,
  true as is_active,
  f.id as facility_id,
  f.tenant_id,
  now() as created_at,
  now() as updated_at
FROM facilities f
CROSS JOIN (
  VALUES 
    ('HIV/AIDS Treatment Program', 'HIV'),
    ('Antenatal Care (ANC) Program', 'ANC'),
    ('Family Planning Program', 'FP'),
    ('Tuberculosis (TB) Program', 'TB'),
    ('Malaria Prevention Program', 'MALARIA'),
    ('Child Immunization (EPI)', 'EPI'),
    ('Nutrition Support Program', 'NUTRITION'),
    ('PMTCT Program', 'PMTCT'),
    ('Mental Health Services', 'MENTAL'),
    ('Safe Motherhood Initiative', 'SMI'),
    ('Emergency Medical Services', 'EMS'),
    ('Community Health Program', 'CHW'),
    ('NCDs Management', 'NCD'),
    ('WASH Program', 'WASH'),
    ('Cervical Cancer Screening', 'CERVICAL'),
    ('Postnatal Care Program', 'PNC'),
    ('Integrated Management of Childhood Illness', 'IMCI'),
    ('Leprosy Control Program', 'LEPROSY'),
    ('Voluntary Medical Male Circumcision', 'VMMC'),
    ('General Free Service', 'FREE')
) AS prog(name, code)
WHERE NOT EXISTS (
  SELECT 1 FROM public.programs p 
  WHERE p.facility_id = f.id 
  AND p.code = prog.code
);

-- Add a comment to the programs table
COMMENT ON TABLE public.programs IS 'Master data for donor-funded and free service programs available at health facilities';