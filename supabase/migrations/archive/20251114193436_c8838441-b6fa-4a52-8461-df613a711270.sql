-- Ensure foreign key relationships for payments are present so PostgREST can embed visits/patients/users
-- These statements are idempotent: they check for existing constraints before adding

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'payments_visit_id_fkey'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_visit_id_fkey
      FOREIGN KEY (visit_id)
      REFERENCES public.visits(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'payments_patient_id_fkey'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_patient_id_fkey
      FOREIGN KEY (patient_id)
      REFERENCES public.patients(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'payments_facility_id_fkey'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_facility_id_fkey
      FOREIGN KEY (facility_id)
      REFERENCES public.facilities(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'payments_cashier_id_fkey'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_cashier_id_fkey
      FOREIGN KEY (cashier_id)
      REFERENCES public.users(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'payments_tenant_id_fkey'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_tenant_id_fkey
      FOREIGN KEY (tenant_id)
      REFERENCES public.tenants(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- Helpful indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_payments_visit_id ON public.payments(visit_id);
CREATE INDEX IF NOT EXISTS idx_payments_patient_id ON public.payments(patient_id);
CREATE INDEX IF NOT EXISTS idx_payments_facility_id ON public.payments(facility_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON public.payments(payment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_facility ON public.payments(tenant_id, facility_id);