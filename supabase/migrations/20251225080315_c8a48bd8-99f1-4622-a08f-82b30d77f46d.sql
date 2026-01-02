-- Create imaging_study_catalog table for managing imaging study types
CREATE TABLE public.imaging_study_catalog (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    facility_id uuid REFERENCES public.facilities(id),
    study_name text NOT NULL,
    study_code text,
    modality text NOT NULL, -- X-Ray, CT, MRI, Ultrasound, etc.
    body_part text,
    description text,
    preparation_instructions text,
    estimated_duration_minutes integer,
    price numeric(10,2),
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by uuid REFERENCES public.users(id),
    UNIQUE(tenant_id, facility_id, study_code)
);

-- Enable RLS
ALTER TABLE public.imaging_study_catalog ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "RBAC: Staff can view imaging studies"
ON public.imaging_study_catalog
FOR SELECT
USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Admins can manage imaging studies"
ON public.imaging_study_catalog
FOR ALL
USING (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'medical_director'::text, 'radiologist'::text]))
    AND tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'medical_director'::text, 'radiologist'::text]))
    AND tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

-- Create updated_at trigger
CREATE TRIGGER update_imaging_study_catalog_updated_at
    BEFORE UPDATE ON public.imaging_study_catalog
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Add indexes
CREATE INDEX idx_imaging_study_catalog_tenant ON public.imaging_study_catalog(tenant_id, facility_id);
CREATE INDEX idx_imaging_study_catalog_modality ON public.imaging_study_catalog(modality);
CREATE INDEX idx_imaging_study_catalog_active ON public.imaging_study_catalog(is_active) WHERE is_active = true;

-- Add RLS policies to lab_test_master for clinic-admin management
DROP POLICY IF EXISTS "RBAC: Staff can view lab tests" ON public.lab_test_master;
DROP POLICY IF EXISTS "RBAC: Admins can manage lab tests" ON public.lab_test_master;

CREATE POLICY "RBAC: Staff can view lab tests"
ON public.lab_test_master
FOR SELECT
USING (
    tenant_id = get_user_tenant_id()
);

CREATE POLICY "RBAC: Admins can manage lab tests"
ON public.lab_test_master
FOR ALL
USING (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'medical_director'::text, 'lab_technician'::text]))
    AND tenant_id = get_user_tenant_id()
)
WITH CHECK (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'medical_director'::text, 'lab_technician'::text]))
    AND tenant_id = get_user_tenant_id()
);

-- Add RLS policies to medication_master for clinic-admin management
DROP POLICY IF EXISTS "RBAC: Staff can view medications" ON public.medication_master;
DROP POLICY IF EXISTS "RBAC: Admins can manage medications" ON public.medication_master;

CREATE POLICY "RBAC: Staff can view medications"
ON public.medication_master
FOR SELECT
USING (
    tenant_id = get_user_tenant_id()
);

CREATE POLICY "RBAC: Admins can manage medications"
ON public.medication_master
FOR ALL
USING (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'pharmacist'::text]))
    AND tenant_id = get_user_tenant_id()
)
WITH CHECK (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'pharmacist'::text]))
    AND tenant_id = get_user_tenant_id()
);