-- Drop and recreate wards policy to include clinic-admin role
DROP POLICY IF EXISTS "RBAC: Admins can manage wards" ON public.wards;

CREATE POLICY "RBAC: Admins can manage wards" 
ON public.wards 
FOR ALL 
USING (
  current_user_has_any_role(ARRAY['nursing_head'::text, 'admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'medical_director'::text])
  AND tenant_id = get_user_tenant_id()
  AND facility_id IN (SELECT unnest(get_user_facility_ids()))
)
WITH CHECK (
  current_user_has_any_role(ARRAY['nursing_head'::text, 'admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'medical_director'::text])
  AND tenant_id = get_user_tenant_id()
  AND facility_id IN (SELECT unnest(get_user_facility_ids()))
);