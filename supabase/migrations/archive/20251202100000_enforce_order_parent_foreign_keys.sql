-- Ensure medical order tables maintain referential integrity

-- Clean up orphaned lab orders before enforcing constraints
DELETE FROM public.lab_orders lo
WHERE NOT EXISTS (
  SELECT 1 FROM public.patients p WHERE p.id = lo.patient_id
);

DELETE FROM public.lab_orders lo
WHERE NOT EXISTS (
  SELECT 1 FROM public.users u WHERE u.id = lo.ordered_by
);

UPDATE public.lab_orders lo
SET rejected_by = NULL,
    rejected_at = NULL,
    rejection_reason = NULL
WHERE rejected_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = lo.rejected_by
  );

-- Clean up orphaned imaging orders
DELETE FROM public.imaging_orders io
WHERE NOT EXISTS (
  SELECT 1 FROM public.patients p WHERE p.id = io.patient_id
);

DELETE FROM public.imaging_orders io
WHERE NOT EXISTS (
  SELECT 1 FROM public.users u WHERE u.id = io.ordered_by
);

-- Clean up orphaned medication orders
DELETE FROM public.medication_orders mo
WHERE NOT EXISTS (
  SELECT 1 FROM public.patients p WHERE p.id = mo.patient_id
);

DELETE FROM public.medication_orders mo
WHERE NOT EXISTS (
  SELECT 1 FROM public.users u WHERE u.id = mo.ordered_by
);

-- Add missing foreign key constraints for lab_orders
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_patient_id_fkey'
  ) THEN
    ALTER TABLE public.lab_orders
      ADD CONSTRAINT lab_orders_patient_id_fkey
      FOREIGN KEY (patient_id)
      REFERENCES public.patients(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_ordered_by_fkey'
  ) THEN
    ALTER TABLE public.lab_orders
      ADD CONSTRAINT lab_orders_ordered_by_fkey
      FOREIGN KEY (ordered_by)
      REFERENCES public.users(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_rejected_by_fkey'
  ) THEN
    ALTER TABLE public.lab_orders
      ADD CONSTRAINT lab_orders_rejected_by_fkey
      FOREIGN KEY (rejected_by)
      REFERENCES public.users(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- Add missing foreign key constraints for imaging_orders
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'imaging_orders_patient_id_fkey'
  ) THEN
    ALTER TABLE public.imaging_orders
      ADD CONSTRAINT imaging_orders_patient_id_fkey
      FOREIGN KEY (patient_id)
      REFERENCES public.patients(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'imaging_orders_ordered_by_fkey'
  ) THEN
    ALTER TABLE public.imaging_orders
      ADD CONSTRAINT imaging_orders_ordered_by_fkey
      FOREIGN KEY (ordered_by)
      REFERENCES public.users(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- Add missing foreign key constraints for medication_orders
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'medication_orders_patient_id_fkey'
  ) THEN
    ALTER TABLE public.medication_orders
      ADD CONSTRAINT medication_orders_patient_id_fkey
      FOREIGN KEY (patient_id)
      REFERENCES public.patients(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'medication_orders_ordered_by_fkey'
  ) THEN
    ALTER TABLE public.medication_orders
      ADD CONSTRAINT medication_orders_ordered_by_fkey
      FOREIGN KEY (ordered_by)
      REFERENCES public.users(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;
