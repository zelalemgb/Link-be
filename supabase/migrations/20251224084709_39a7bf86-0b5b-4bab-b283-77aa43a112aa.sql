-- Seed wards for Opian Health care Center (idempotent)
WITH ctx AS (
  SELECT
    '23e60de7-16f3-4789-a99b-61de613caa9b'::uuid AS facility_id,
    '00000000-0000-0000-0000-000000000001'::uuid AS tenant_id
)
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
JOIN public.departments d
  ON d.code = w.dept_code
 AND d.facility_id = ctx.facility_id
 AND d.tenant_id = ctx.tenant_id
ON CONFLICT DO NOTHING;

SELECT 'Opian wards seed completed' AS status;