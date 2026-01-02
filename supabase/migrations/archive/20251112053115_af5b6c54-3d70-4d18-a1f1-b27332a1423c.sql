-- Create insurers table
CREATE TABLE IF NOT EXISTS public.insurers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id UUID REFERENCES public.facilities(id),
  name TEXT NOT NULL,
  code TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.users(id)
);

-- Create creditors table
CREATE TABLE IF NOT EXISTS public.creditors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id UUID REFERENCES public.facilities(id),
  name TEXT NOT NULL,
  code TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.users(id)
);

-- Create programs table
CREATE TABLE IF NOT EXISTS public.programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  facility_id UUID REFERENCES public.facilities(id),
  name TEXT NOT NULL,
  code TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.users(id)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_insurers_tenant_id ON public.insurers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_insurers_facility_id ON public.insurers(facility_id);
CREATE INDEX IF NOT EXISTS idx_insurers_tenant_active ON public.insurers(tenant_id, is_active);

CREATE INDEX IF NOT EXISTS idx_creditors_tenant_id ON public.creditors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_creditors_facility_id ON public.creditors(facility_id);
CREATE INDEX IF NOT EXISTS idx_creditors_tenant_active ON public.creditors(tenant_id, is_active);

CREATE INDEX IF NOT EXISTS idx_programs_tenant_id ON public.programs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_programs_facility_id ON public.programs(facility_id);
CREATE INDEX IF NOT EXISTS idx_programs_tenant_active ON public.programs(tenant_id, is_active);

-- Enable RLS
ALTER TABLE public.insurers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creditors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for insurers
CREATE POLICY "Users can view insurers for their tenant"
  ON public.insurers FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id = get_user_facility_id())
  );

CREATE POLICY "Admins can insert insurers"
  ON public.insurers FOR INSERT
  WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

CREATE POLICY "Admins can update insurers"
  ON public.insurers FOR UPDATE
  USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

CREATE POLICY "Admins can delete insurers"
  ON public.insurers FOR DELETE
  USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

-- RLS Policies for creditors
CREATE POLICY "Users can view creditors for their tenant"
  ON public.creditors FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id = get_user_facility_id())
  );

CREATE POLICY "Admins can insert creditors"
  ON public.creditors FOR INSERT
  WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

CREATE POLICY "Admins can update creditors"
  ON public.creditors FOR UPDATE
  USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

CREATE POLICY "Admins can delete creditors"
  ON public.creditors FOR DELETE
  USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

-- RLS Policies for programs
CREATE POLICY "Users can view programs for their tenant"
  ON public.programs FOR SELECT
  USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id IS NULL OR facility_id = get_user_facility_id())
  );

CREATE POLICY "Admins can insert programs"
  ON public.programs FOR INSERT
  WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

CREATE POLICY "Admins can update programs"
  ON public.programs FOR UPDATE
  USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

CREATE POLICY "Admins can delete programs"
  ON public.programs FOR DELETE
  USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('admin', 'super_admin', 'hospital_ceo', 'medical_director')
    )
  );

-- Trigger to update updated_at timestamp
CREATE TRIGGER update_insurers_updated_at
  BEFORE UPDATE ON public.insurers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_creditors_updated_at
  BEFORE UPDATE ON public.creditors
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_programs_updated_at
  BEFORE UPDATE ON public.programs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();