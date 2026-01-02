-- Update RLS policies for insurers table to include clinic-admin
DROP POLICY IF EXISTS "RBAC: Admins can manage insurers" ON public.insurers;
DROP POLICY IF EXISTS "RBAC: Staff can view insurers" ON public.insurers;

CREATE POLICY "RBAC: Admins can manage insurers"
ON public.insurers
FOR ALL
USING (
  current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'finance_officer'::text])
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
  current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'finance_officer'::text])
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Staff can view insurers"
ON public.insurers
FOR SELECT
USING (
  tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

-- Update RLS policies for suppliers table to include clinic-admin
DROP POLICY IF EXISTS "RBAC: Admins can manage suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "RBAC: Staff can view suppliers" ON public.suppliers;

CREATE POLICY "RBAC: Admins can manage suppliers"
ON public.suppliers
FOR ALL
USING (
  current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'logistics_officer'::text])
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
  current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'logistics_officer'::text])
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Staff can view suppliers"
ON public.suppliers
FOR SELECT
USING (
  tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

-- Update RLS policies for creditors table to include clinic-admin
DROP POLICY IF EXISTS "RBAC: Admins can manage creditors" ON public.creditors;
DROP POLICY IF EXISTS "RBAC: Staff can view creditors" ON public.creditors;

CREATE POLICY "RBAC: Admins can manage creditors"
ON public.creditors
FOR ALL
USING (
  current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'finance_officer'::text])
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
  current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'finance_officer'::text])
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Staff can view creditors"
ON public.creditors
FOR SELECT
USING (
  tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);