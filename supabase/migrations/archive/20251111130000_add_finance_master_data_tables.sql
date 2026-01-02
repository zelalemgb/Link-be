BEGIN;

CREATE TABLE IF NOT EXISTS public.insurers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES public.facilities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  contact_info JSONB,
  metadata JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, name)
);

CREATE INDEX IF NOT EXISTS idx_insurers_tenant ON public.insurers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_insurers_facility ON public.insurers(facility_id);

CREATE TABLE IF NOT EXISTS public.creditors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES public.facilities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  contact_info JSONB,
  metadata JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, name)
);

CREATE INDEX IF NOT EXISTS idx_creditors_tenant ON public.creditors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_creditors_facility ON public.creditors(facility_id);

CREATE TABLE IF NOT EXISTS public.programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id UUID REFERENCES public.facilities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  category TEXT,
  metadata JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, name)
);

CREATE INDEX IF NOT EXISTS idx_programs_tenant ON public.programs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_programs_facility ON public.programs(facility_id);

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

INSERT INTO public.insurers (tenant_id, facility_id, name)
SELECT DISTINCT pay.tenant_id, pay.facility_id, btrim(pli.insurance_provider)
FROM public.payment_line_items pli
JOIN public.payments pay ON pay.id = pli.payment_id
WHERE pli.insurance_provider IS NOT NULL
  AND btrim(pli.insurance_provider) <> ''
ON CONFLICT DO NOTHING;

ALTER TABLE public.payment_line_items
  ADD COLUMN IF NOT EXISTS insurance_provider_id UUID REFERENCES public.insurers(id) ON DELETE SET NULL;

ALTER TABLE public.payment_line_items
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id) ON DELETE SET NULL;

ALTER TABLE public.payment_line_items
  ADD COLUMN IF NOT EXISTS creditor_name TEXT;

ALTER TABLE public.payment_line_items
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id) ON DELETE SET NULL;

ALTER TABLE public.payment_line_items
  ADD COLUMN IF NOT EXISTS program_name TEXT;

UPDATE public.payment_line_items pli
SET insurance_provider_id = ins.id
FROM public.payments pay
JOIN public.insurers ins
  ON ins.tenant_id = pay.tenant_id
  AND (ins.facility_id = pay.facility_id OR ins.facility_id IS NULL)
  AND ins.name = btrim(pli.insurance_provider)
WHERE pli.payment_id = pay.id
  AND pli.insurance_provider IS NOT NULL
  AND btrim(pli.insurance_provider) <> ''
  AND pli.insurance_provider_id IS NULL;

ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id) ON DELETE SET NULL;

ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS creditor_name TEXT;

ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id) ON DELETE SET NULL;

ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS program_name TEXT;

ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id) ON DELETE SET NULL;

ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS creditor_name TEXT;

ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id) ON DELETE SET NULL;

ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS program_name TEXT;

ALTER TABLE public.imaging_orders
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id) ON DELETE SET NULL;

ALTER TABLE public.imaging_orders
  ADD COLUMN IF NOT EXISTS creditor_name TEXT;

ALTER TABLE public.imaging_orders
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id) ON DELETE SET NULL;

ALTER TABLE public.imaging_orders
  ADD COLUMN IF NOT EXISTS program_name TEXT;

ALTER TABLE public.billing_items
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id) ON DELETE SET NULL;

ALTER TABLE public.billing_items
  ADD COLUMN IF NOT EXISTS creditor_name TEXT;

ALTER TABLE public.billing_items
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id) ON DELETE SET NULL;

ALTER TABLE public.billing_items
  ADD COLUMN IF NOT EXISTS program_name TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_line_items_insurer ON public.payment_line_items(insurance_provider_id);
CREATE INDEX IF NOT EXISTS idx_payment_line_items_creditor ON public.payment_line_items(creditor_id);
CREATE INDEX IF NOT EXISTS idx_payment_line_items_program ON public.payment_line_items(program_id);

CREATE INDEX IF NOT EXISTS idx_medication_orders_creditor ON public.medication_orders(creditor_id);
CREATE INDEX IF NOT EXISTS idx_medication_orders_program ON public.medication_orders(program_id);

CREATE INDEX IF NOT EXISTS idx_lab_orders_creditor ON public.lab_orders(creditor_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_program ON public.lab_orders(program_id);

CREATE INDEX IF NOT EXISTS idx_imaging_orders_creditor ON public.imaging_orders(creditor_id);
CREATE INDEX IF NOT EXISTS idx_imaging_orders_program ON public.imaging_orders(program_id);

CREATE INDEX IF NOT EXISTS idx_billing_items_creditor ON public.billing_items(creditor_id);
CREATE INDEX IF NOT EXISTS idx_billing_items_program ON public.billing_items(program_id);

COMMIT;
