-- Drop and recreate programs policy to include clinic-admin role
DROP POLICY IF EXISTS "RBAC: Admins can manage programs" ON public.programs;

CREATE POLICY "RBAC: Admins can manage programs" 
ON public.programs 
FOR ALL 
USING (
  (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'hospital_ceo'::text, 'medical_director'::text, 'super_admin'::text]))
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
  (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'hospital_ceo'::text, 'medical_director'::text, 'super_admin'::text]))
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);