-- Migration: 20260115120000_seed_global_master_data.sql
-- Description: Seeds global master data (Insurers, Programs) available to all facilities (facility_id = NULL)

BEGIN;

-- 1. Helper CTE to identify the default/first tenant
WITH target_tenant AS (
  SELECT id FROM public.tenants ORDER BY created_at LIMIT 1
),
-- 2. Helper CTE to identify the admin user for 'created_by'
admin_user AS (
  SELECT id FROM public.users ORDER BY created_at LIMIT 1
)

-- 3. Insert Global Insurers (facility_id = NULL)
INSERT INTO public.insurers (
  tenant_id, 
  facility_id, 
  name, 
  code, 
  contact_info, 
  is_active, 
  created_by
)
SELECT 
  (SELECT id FROM target_tenant),
  NULL, -- Global availability
  v.name, 
  v.code, 
  jsonb_build_object('email', v.email, 'phone', v.phone),
  true,
  (SELECT id FROM admin_user)
FROM (VALUES
  ('Ethiopian Health Insurance Agency', 'EHIA', 'claims@ehia.gov.et', '+251115571234'),
  ('Community Based Health Insurance', 'CBHI', 'cbhi@health.gov.et', '+251115572345'),
  ('Nyala Insurance', 'NYALA', 'health@nyalainsurance.com', '+251115513456'),
  ('Awash Insurance', 'AWASH', 'medical@awashinsurance.com', '+251115514567'),
  ('Ethiopian Insurance Corporation', 'EIC', 'claims@eic.com.et', '+251115515678'),
  ('United Insurance', 'UNITED', 'health@unitedinsurance.et', '+251115516789'),
  ('Africa Insurance', 'AFRICA', 'claims@africainsurance.et', '+251115517890'),
  ('Oromia Insurance', 'OIC', 'medical@oromiainsurance.com', '+251115518901')
) AS v(name, code, email, phone)
-- Prevent duplicates if they already exist globally
ON CONFLICT (tenant_id, facility_id, name) DO NOTHING;

-- 4. Insert Global Programs (facility_id = NULL)
WITH target_tenant AS (
  SELECT id FROM public.tenants ORDER BY created_at LIMIT 1
),
admin_user AS (
  SELECT id FROM public.users ORDER BY created_at LIMIT 1
)
INSERT INTO public.programs (
  tenant_id, 
  facility_id, 
  name, 
  code, 
  category, 
  is_active, 
  created_by
)
SELECT 
  (SELECT id FROM target_tenant),
  NULL, -- Global availability
  v.name, 
  v.code, 
  'Public Health',
  true,
  (SELECT id FROM admin_user)
FROM (VALUES
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
ON CONFLICT (tenant_id, facility_id, name) DO NOTHING;

-- 5. Insert Global Creditors (facility_id = NULL) - Optional but good for completeness
WITH target_tenant AS (
  SELECT id FROM public.tenants ORDER BY created_at LIMIT 1
),
admin_user AS (
  SELECT id FROM public.users ORDER BY created_at LIMIT 1
)
INSERT INTO public.creditors (
  tenant_id, 
  facility_id, 
  name, 
  code, 
  is_active, 
  created_by
)
SELECT 
  (SELECT id FROM target_tenant),
  NULL, 
  v.name, 
  v.code, 
  true,
  (SELECT id FROM admin_user)
FROM (VALUES
  ('Partner NGO', 'NGO'),
  ('Corporate Partner A', 'CORP-A'),
  ('Government Agency', 'GOV')
) AS v(name, code)
ON CONFLICT (tenant_id, facility_id, name) DO NOTHING;

COMMIT;
