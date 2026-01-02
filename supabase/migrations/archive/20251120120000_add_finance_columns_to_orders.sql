-- Add finance master list columns to medication_orders
ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS insurance_provider_id UUID REFERENCES public.insurers(id),
  ADD COLUMN IF NOT EXISTS insurance_provider_name TEXT,
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id),
  ADD COLUMN IF NOT EXISTS creditor_name TEXT,
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id),
  ADD COLUMN IF NOT EXISTS program_name TEXT;

-- Add finance master list columns to lab_orders
ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS insurance_provider_id UUID REFERENCES public.insurers(id),
  ADD COLUMN IF NOT EXISTS insurance_provider_name TEXT,
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id),
  ADD COLUMN IF NOT EXISTS creditor_name TEXT,
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id),
  ADD COLUMN IF NOT EXISTS program_name TEXT;

-- Add finance master list columns to imaging_orders
ALTER TABLE public.imaging_orders
  ADD COLUMN IF NOT EXISTS insurance_provider_id UUID REFERENCES public.insurers(id),
  ADD COLUMN IF NOT EXISTS insurance_provider_name TEXT,
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id),
  ADD COLUMN IF NOT EXISTS creditor_name TEXT,
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id),
  ADD COLUMN IF NOT EXISTS program_name TEXT;

-- Add finance master list columns to billing_items
ALTER TABLE public.billing_items
  ADD COLUMN IF NOT EXISTS insurance_provider_id UUID REFERENCES public.insurers(id),
  ADD COLUMN IF NOT EXISTS insurance_provider_name TEXT,
  ADD COLUMN IF NOT EXISTS creditor_id UUID REFERENCES public.creditors(id),
  ADD COLUMN IF NOT EXISTS creditor_name TEXT,
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.programs(id),
  ADD COLUMN IF NOT EXISTS program_name TEXT;

-- Create indexes for foreign key lookups
CREATE INDEX IF NOT EXISTS idx_medication_orders_insurance_provider 
  ON public.medication_orders(insurance_provider_id);
CREATE INDEX IF NOT EXISTS idx_medication_orders_creditor 
  ON public.medication_orders(creditor_id);
CREATE INDEX IF NOT EXISTS idx_medication_orders_program 
  ON public.medication_orders(program_id);

CREATE INDEX IF NOT EXISTS idx_lab_orders_insurance_provider 
  ON public.lab_orders(insurance_provider_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_creditor 
  ON public.lab_orders(creditor_id);
CREATE INDEX IF NOT EXISTS idx_lab_orders_program 
  ON public.lab_orders(program_id);

CREATE INDEX IF NOT EXISTS idx_imaging_orders_insurance_provider 
  ON public.imaging_orders(insurance_provider_id);
CREATE INDEX IF NOT EXISTS idx_imaging_orders_creditor 
  ON public.imaging_orders(creditor_id);
CREATE INDEX IF NOT EXISTS idx_imaging_orders_program 
  ON public.imaging_orders(program_id);

CREATE INDEX IF NOT EXISTS idx_billing_items_insurance_provider 
  ON public.billing_items(insurance_provider_id);
CREATE INDEX IF NOT EXISTS idx_billing_items_creditor 
  ON public.billing_items(creditor_id);
CREATE INDEX IF NOT EXISTS idx_billing_items_program 
  ON public.billing_items(program_id);
