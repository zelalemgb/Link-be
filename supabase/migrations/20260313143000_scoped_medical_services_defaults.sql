BEGIN;

ALTER TABLE public.medical_services
  ALTER COLUMN facility_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_medical_services_scope
  ON public.medical_services(tenant_id, facility_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_medical_services_scope_code_unique
  ON public.medical_services(
    tenant_id,
    COALESCE(facility_id, '00000000-0000-0000-0000-000000000000'::UUID),
    code
  )
  WHERE code IS NOT NULL;

DROP POLICY IF EXISTS "RBAC: Staff can view medical services" ON public.medical_services;
DROP POLICY IF EXISTS "RBAC: Admins can manage medical services" ON public.medical_services;
DROP POLICY IF EXISTS "Clinic admins can manage their facility services" ON public.medical_services;

CREATE POLICY "RBAC: Staff can view medical services"
  ON public.medical_services
  FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
  );

CREATE POLICY "RBAC: Admins can manage medical services"
  ON public.medical_services
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

COMMIT;
