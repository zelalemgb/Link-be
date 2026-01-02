-- Phase 1: Foundation (Multi-Tenancy & Identity)
-- Step 1: Create tenants table
CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE,
  settings JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on tenants
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- Create default tenant for existing data
INSERT INTO public.tenants (id, name, subdomain, is_active)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Tenant', 'default', true)
ON CONFLICT (id) DO NOTHING;

-- Step 2: Add tenant_id to facilities (anchor table)
ALTER TABLE public.facilities 
ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) DEFAULT '00000000-0000-0000-0000-000000000001';

-- Backfill existing facilities with default tenant
UPDATE public.facilities 
SET tenant_id = '00000000-0000-0000-0000-000000000001' 
WHERE tenant_id IS NULL;

-- Make tenant_id NOT NULL after backfill
ALTER TABLE public.facilities 
ALTER COLUMN tenant_id SET NOT NULL;

-- Step 3: Add tenant_id to users
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

-- Backfill users.tenant_id from their facility
UPDATE public.users u
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE u.facility_id = f.id AND u.tenant_id IS NULL;

-- For users without facility, use default tenant
UPDATE public.users 
SET tenant_id = '00000000-0000-0000-0000-000000000001' 
WHERE tenant_id IS NULL;

ALTER TABLE public.users 
ALTER COLUMN tenant_id SET NOT NULL;

-- Step 4: Add tenant_id to patients
ALTER TABLE public.patients 
ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

-- Backfill patients.tenant_id from their facility
UPDATE public.patients p
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE p.facility_id = f.id AND p.tenant_id IS NULL;

-- For patients without facility, use default tenant
UPDATE public.patients 
SET tenant_id = '00000000-0000-0000-0000-000000000001' 
WHERE tenant_id IS NULL;

ALTER TABLE public.patients 
ALTER COLUMN tenant_id SET NOT NULL;

-- Step 5: Create patient_identifiers table
CREATE TABLE IF NOT EXISTS public.patient_identifiers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  identifier_type TEXT NOT NULL CHECK (identifier_type IN ('fayida_id', 'mrn', 'national_id', 'passport', 'insurance_id', 'other')),
  identifier_value TEXT NOT NULL,
  is_primary BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, identifier_type, identifier_value)
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_patient_identifiers_patient_id ON public.patient_identifiers(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_identifiers_tenant_id ON public.patient_identifiers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_identifiers_value ON public.patient_identifiers(identifier_value);

-- Enable RLS on patient_identifiers
ALTER TABLE public.patient_identifiers ENABLE ROW LEVEL SECURITY;

-- Migrate existing fayida_id data to patient_identifiers
INSERT INTO public.patient_identifiers (patient_id, tenant_id, identifier_type, identifier_value, is_primary, created_at)
SELECT 
  id as patient_id,
  tenant_id,
  'fayida_id' as identifier_type,
  fayida_id as identifier_value,
  true as is_primary,
  created_at
FROM public.patients
WHERE fayida_id IS NOT NULL AND fayida_id != ''
ON CONFLICT (tenant_id, identifier_type, identifier_value) DO NOTHING;

-- Step 6: Add tenant_id to other core tables
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.visits v SET tenant_id = f.tenant_id FROM public.facilities f WHERE v.facility_id = f.id AND v.tenant_id IS NULL;
UPDATE public.visits SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.visits ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.lab_orders ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.lab_orders lo SET tenant_id = v.tenant_id FROM public.visits v WHERE lo.visit_id = v.id AND lo.tenant_id IS NULL;
UPDATE public.lab_orders SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.lab_orders ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.imaging_orders ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.imaging_orders io SET tenant_id = v.tenant_id FROM public.visits v WHERE io.visit_id = v.id AND io.tenant_id IS NULL;
UPDATE public.imaging_orders SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.imaging_orders ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.medication_orders ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.medication_orders mo SET tenant_id = v.tenant_id FROM public.visits v WHERE mo.visit_id = v.id AND mo.tenant_id IS NULL;
UPDATE public.medication_orders SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.medication_orders ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.billing_items ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.billing_items bi SET tenant_id = v.tenant_id FROM public.visits v WHERE bi.visit_id = v.id AND bi.tenant_id IS NULL;
UPDATE public.billing_items SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.billing_items ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
UPDATE public.payments p SET tenant_id = f.tenant_id FROM public.facilities f WHERE p.facility_id = f.id AND p.tenant_id IS NULL;
UPDATE public.payments SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE public.payments ALTER COLUMN tenant_id SET NOT NULL;

-- Step 7: Create RLS policies for tenants
CREATE POLICY "Super admins can view all tenants" ON public.tenants
  FOR SELECT USING (is_super_admin());

CREATE POLICY "Users can view their own tenant" ON public.tenants
  FOR SELECT USING (id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));

CREATE POLICY "Super admins can manage all tenants" ON public.tenants
  FOR ALL USING (is_super_admin());

-- Step 8: Create RLS policies for patient_identifiers
CREATE POLICY "Facility staff can view patient identifiers" ON public.patient_identifiers
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND patient_id IN (
      SELECT id
      FROM public.patients
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
  );

CREATE POLICY "Staff can create patient identifiers" ON public.patient_identifiers
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND patient_id IN (
      SELECT id
      FROM public.patients
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
  );

CREATE POLICY "Staff can update patient identifiers" ON public.patient_identifiers
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND patient_id IN (
      SELECT id
      FROM public.patients
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
  );

-- Step 9: Update get_user_facility_id function to be tenant-aware
CREATE OR REPLACE FUNCTION public.get_user_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- Step 10: Create trigger for updated_at on tenants
CREATE TRIGGER update_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_patient_identifiers_updated_at
  BEFORE UPDATE ON public.patient_identifiers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();