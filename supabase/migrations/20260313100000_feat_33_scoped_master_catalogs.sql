-- ============================================================
-- FEAT 33: Scoped Master Catalogs
-- ============================================================
-- Normalizes clinical master data around tenant defaults with optional
-- facility overrides, and introduces a dedicated equipment catalog
-- separate from operational inventory items.

BEGIN;

ALTER TABLE public.medication_master
  ADD COLUMN IF NOT EXISTS facility_id UUID REFERENCES public.facilities(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB;

UPDATE public.medication_master
SET metadata = '{}'::JSONB
WHERE metadata IS NULL;

ALTER TABLE public.lab_test_master
  ADD COLUMN IF NOT EXISTS facility_id UUID REFERENCES public.facilities(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB;

UPDATE public.lab_test_master
SET metadata = '{}'::JSONB
WHERE metadata IS NULL;

ALTER TABLE public.lab_test_master
  DROP CONSTRAINT IF EXISTS lab_test_master_test_code_key;

CREATE INDEX IF NOT EXISTS idx_medication_master_scope
  ON public.medication_master(tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_lab_test_master_scope
  ON public.lab_test_master(tenant_id, facility_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lab_test_master_scope_code_unique
  ON public.lab_test_master(
    tenant_id,
    COALESCE(facility_id, '00000000-0000-0000-0000-000000000000'::UUID),
    test_code
  );

CREATE TABLE IF NOT EXISTS public.equipment_master (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES public.facilities(id) ON DELETE CASCADE,
  equipment_name TEXT NOT NULL,
  equipment_code TEXT,
  category TEXT NOT NULL DEFAULT 'General',
  unit_of_measure TEXT NOT NULL DEFAULT 'unit',
  manufacturer TEXT,
  model_number TEXT,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.equipment_master ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_equipment_master_scope
  ON public.equipment_master(tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_equipment_master_category
  ON public.equipment_master(category);

CREATE INDEX IF NOT EXISTS idx_equipment_master_active
  ON public.equipment_master(is_active)
  WHERE is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_master_scope_code_unique
  ON public.equipment_master(
    tenant_id,
    COALESCE(facility_id, '00000000-0000-0000-0000-000000000000'::UUID),
    equipment_code
  )
  WHERE equipment_code IS NOT NULL;

DROP POLICY IF EXISTS "RBAC: Staff can view lab tests" ON public.lab_test_master;
DROP POLICY IF EXISTS "RBAC: Admins can manage lab tests" ON public.lab_test_master;
DROP POLICY IF EXISTS "Allow all authenticated users to view lab test master" ON public.lab_test_master;
DROP POLICY IF EXISTS "Super admins can manage lab test master" ON public.lab_test_master;

CREATE POLICY "RBAC: Staff can view lab tests"
ON public.lab_test_master
FOR SELECT
USING (
  tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Admins can manage lab tests"
ON public.lab_test_master
FOR ALL
USING (
  (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::TEXT, 'clinic-admin'::TEXT, 'super_admin'::TEXT, 'hospital_ceo'::TEXT, 'medical_director'::TEXT, 'lab_technician'::TEXT]))
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
  (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::TEXT, 'clinic-admin'::TEXT, 'super_admin'::TEXT, 'hospital_ceo'::TEXT, 'medical_director'::TEXT, 'lab_technician'::TEXT]))
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

DROP POLICY IF EXISTS "RBAC: Staff can view medications" ON public.medication_master;
DROP POLICY IF EXISTS "RBAC: Admins can manage medications" ON public.medication_master;
DROP POLICY IF EXISTS "All authenticated users can view medications" ON public.medication_master;
DROP POLICY IF EXISTS "Medical staff and admins can manage medications" ON public.medication_master;

CREATE POLICY "RBAC: Staff can view medications"
ON public.medication_master
FOR SELECT
USING (
  tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Admins can manage medications"
ON public.medication_master
FOR ALL
USING (
  (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::TEXT, 'clinic-admin'::TEXT, 'super_admin'::TEXT, 'hospital_ceo'::TEXT, 'pharmacist'::TEXT]))
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
  (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::TEXT, 'clinic-admin'::TEXT, 'super_admin'::TEXT, 'hospital_ceo'::TEXT, 'pharmacist'::TEXT]))
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Staff can view equipment catalog"
ON public.equipment_master
FOR SELECT
USING (
  tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Admins can manage equipment catalog"
ON public.equipment_master
FOR ALL
USING (
  (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::TEXT, 'clinic-admin'::TEXT, 'super_admin'::TEXT, 'hospital_ceo'::TEXT, 'medical_director'::TEXT, 'logistic_officer'::TEXT]))
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
  (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::TEXT, 'clinic-admin'::TEXT, 'super_admin'::TEXT, 'hospital_ceo'::TEXT, 'medical_director'::TEXT, 'logistic_officer'::TEXT]))
  AND tenant_id = get_user_tenant_id()
  AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE TRIGGER update_equipment_master_updated_at
  BEFORE UPDATE ON public.equipment_master
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

COMMIT;
