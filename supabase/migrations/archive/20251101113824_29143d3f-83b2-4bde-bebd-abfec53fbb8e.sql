-- Add foreign keys and indexes for billing_items to enable PostgREST relationships
-- This fixes embedding with visits/patients/services in CashierDashboard

-- Create indexes for performance (safe if they already exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_billing_items_visit_id'
  ) THEN
    CREATE INDEX idx_billing_items_visit_id ON public.billing_items(visit_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_billing_items_patient_id'
  ) THEN
    CREATE INDEX idx_billing_items_patient_id ON public.billing_items(patient_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_billing_items_service_id'
  ) THEN
    CREATE INDEX idx_billing_items_service_id ON public.billing_items(service_id);
  END IF;
END $$;

-- Add foreign key constraints (NOT VALID to avoid blocking if legacy rows exist)
ALTER TABLE public.billing_items
  ADD CONSTRAINT billing_items_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.billing_items
  ADD CONSTRAINT billing_items_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.billing_items
  ADD CONSTRAINT billing_items_service_id_fkey
    FOREIGN KEY (service_id) REFERENCES public.medical_services(id) ON DELETE RESTRICT NOT VALID;

-- Validate constraints (will fail if data inconsistent)
ALTER TABLE public.billing_items VALIDATE CONSTRAINT billing_items_visit_id_fkey;
ALTER TABLE public.billing_items VALIDATE CONSTRAINT billing_items_patient_id_fkey;
ALTER TABLE public.billing_items VALIDATE CONSTRAINT billing_items_service_id_fkey;