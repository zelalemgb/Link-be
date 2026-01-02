-- Create service_categories table for organizing medical services
CREATE TABLE public.service_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id),
    facility_id uuid REFERENCES public.facilities(id),
    name text NOT NULL,
    code text,
    description text,
    display_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by uuid REFERENCES public.users(id),
    UNIQUE(tenant_id, facility_id, code)
);

-- Enable RLS
ALTER TABLE public.service_categories ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "RBAC: Staff can view service categories"
ON public.service_categories
FOR SELECT
USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

CREATE POLICY "RBAC: Admins can manage service categories"
ON public.service_categories
FOR ALL
USING (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'finance_officer'::text]))
    AND tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
)
WITH CHECK (
    (can_manage_master_data() OR current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'super_admin'::text, 'hospital_ceo'::text, 'finance_officer'::text]))
    AND tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id IN (SELECT unnest(get_user_facility_ids())))
);

-- Create updated_at trigger
CREATE TRIGGER update_service_categories_updated_at
    BEFORE UPDATE ON public.service_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Add index for faster lookups
CREATE INDEX idx_service_categories_tenant_facility ON public.service_categories(tenant_id, facility_id);
CREATE INDEX idx_service_categories_active ON public.service_categories(is_active) WHERE is_active = true;