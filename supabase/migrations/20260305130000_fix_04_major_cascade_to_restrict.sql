-- ============================================================
-- FIX 04 — MAJOR: Replace ON DELETE CASCADE with ON DELETE RESTRICT
--                  on all clinical sub-tables
-- ============================================================
-- Problem:
--   Deleting a visit cascades to permanently erase:
--     anc_assessments, delivery_records, emergency_assessments,
--     immunization_records, family_planning_visits,
--     pediatric_assessments, surgical_assessments, billing_items
--   There is no audit trail; the data is gone forever.
--   In healthcare, clinical records should NEVER be silently deleted.
--
-- Fix:
--   Replace every ON DELETE CASCADE FK that points to visits or
--   patients on clinical sub-tables with ON DELETE RESTRICT.
--   If a visit or patient must be removed it should fail loudly
--   until the caller deliberately handles sub-records first.
--
-- Note: billing_items CASCADE to visits is also changed here.
--       If a billing item must be voided, use a 'voided' status
--       field; don't delete the row.
-- ============================================================

BEGIN;

-- Helper: replace a FK on a table
-- Usage: called inside DO blocks below

-- ──────────────────────────────────────────────
-- anc_assessments
-- ──────────────────────────────────────────────
DO $$
BEGIN
  -- visit_id FK
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anc_assessments_visit_id_fkey') THEN
    ALTER TABLE public.anc_assessments DROP CONSTRAINT anc_assessments_visit_id_fkey;
  END IF;
  ALTER TABLE public.anc_assessments
    ADD CONSTRAINT anc_assessments_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE RESTRICT;

  -- patient_id FK
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anc_assessments_patient_id_fkey') THEN
    ALTER TABLE public.anc_assessments DROP CONSTRAINT anc_assessments_patient_id_fkey;
  END IF;
  ALTER TABLE public.anc_assessments
    ADD CONSTRAINT anc_assessments_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- delivery_records
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_records_visit_id_fkey') THEN
    ALTER TABLE public.delivery_records DROP CONSTRAINT delivery_records_visit_id_fkey;
  END IF;
  ALTER TABLE public.delivery_records
    ADD CONSTRAINT delivery_records_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE RESTRICT;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_records_patient_id_fkey') THEN
    ALTER TABLE public.delivery_records DROP CONSTRAINT delivery_records_patient_id_fkey;
  END IF;
  ALTER TABLE public.delivery_records
    ADD CONSTRAINT delivery_records_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- emergency_assessments
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_assessments_visit_id_fkey') THEN
    ALTER TABLE public.emergency_assessments DROP CONSTRAINT emergency_assessments_visit_id_fkey;
  END IF;
  ALTER TABLE public.emergency_assessments
    ADD CONSTRAINT emergency_assessments_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE RESTRICT;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emergency_assessments_patient_id_fkey') THEN
    ALTER TABLE public.emergency_assessments DROP CONSTRAINT emergency_assessments_patient_id_fkey;
  END IF;
  ALTER TABLE public.emergency_assessments
    ADD CONSTRAINT emergency_assessments_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- immunization_records
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'immunization_records_visit_id_fkey') THEN
    ALTER TABLE public.immunization_records DROP CONSTRAINT immunization_records_visit_id_fkey;
  END IF;
  ALTER TABLE public.immunization_records
    ADD CONSTRAINT immunization_records_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE RESTRICT;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'immunization_records_patient_id_fkey') THEN
    ALTER TABLE public.immunization_records DROP CONSTRAINT immunization_records_patient_id_fkey;
  END IF;
  ALTER TABLE public.immunization_records
    ADD CONSTRAINT immunization_records_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- family_planning_visits
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_planning_visits_visit_id_fkey') THEN
    ALTER TABLE public.family_planning_visits DROP CONSTRAINT family_planning_visits_visit_id_fkey;
  END IF;
  ALTER TABLE public.family_planning_visits
    ADD CONSTRAINT family_planning_visits_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE RESTRICT;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_planning_visits_patient_id_fkey') THEN
    ALTER TABLE public.family_planning_visits DROP CONSTRAINT family_planning_visits_patient_id_fkey;
  END IF;
  ALTER TABLE public.family_planning_visits
    ADD CONSTRAINT family_planning_visits_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- pediatric_assessments
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pediatric_assessments_visit_id_fkey') THEN
    ALTER TABLE public.pediatric_assessments DROP CONSTRAINT pediatric_assessments_visit_id_fkey;
  END IF;
  ALTER TABLE public.pediatric_assessments
    ADD CONSTRAINT pediatric_assessments_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE RESTRICT;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pediatric_assessments_patient_id_fkey') THEN
    ALTER TABLE public.pediatric_assessments DROP CONSTRAINT pediatric_assessments_patient_id_fkey;
  END IF;
  ALTER TABLE public.pediatric_assessments
    ADD CONSTRAINT pediatric_assessments_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- surgical_assessments (if table exists)
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'surgical_assessments'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'surgical_assessments_visit_id_fkey') THEN
      ALTER TABLE public.surgical_assessments DROP CONSTRAINT surgical_assessments_visit_id_fkey;
    END IF;
    ALTER TABLE public.surgical_assessments
      ADD CONSTRAINT surgical_assessments_visit_id_fkey
      FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE RESTRICT;

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'surgical_assessments_patient_id_fkey') THEN
      ALTER TABLE public.surgical_assessments DROP CONSTRAINT surgical_assessments_patient_id_fkey;
    END IF;
    ALTER TABLE public.surgical_assessments
      ADD CONSTRAINT surgical_assessments_patient_id_fkey
      FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;

    RAISE NOTICE 'surgical_assessments FKs updated to RESTRICT.';
  ELSE
    RAISE NOTICE 'surgical_assessments table not found — skipped.';
  END IF;
END
$$;

-- ──────────────────────────────────────────────
-- billing_items — change visit CASCADE to RESTRICT
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_items_visit_id_fkey') THEN
    ALTER TABLE public.billing_items DROP CONSTRAINT billing_items_visit_id_fkey;
  END IF;
  ALTER TABLE public.billing_items
    ADD CONSTRAINT billing_items_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id) ON DELETE RESTRICT;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_items_patient_id_fkey') THEN
    ALTER TABLE public.billing_items DROP CONSTRAINT billing_items_patient_id_fkey;
  END IF;
  ALTER TABLE public.billing_items
    ADD CONSTRAINT billing_items_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification: show all FKs pointing to visits/patients
-- and confirm none are CASCADE any more on clinical tables
-- ──────────────────────────────────────────────
SELECT
  t.relname  AS table_name,
  c.conname  AS constraint_name,
  r.relname  AS references_table,
  CASE c.confdeltype
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END        AS on_delete
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_class r ON r.oid = c.confrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype = 'f'
  AND n.nspname = 'public'
  AND r.relname IN ('visits', 'patients')
  AND t.relname IN (
    'anc_assessments', 'delivery_records', 'emergency_assessments',
    'immunization_records', 'family_planning_visits', 'pediatric_assessments',
    'surgical_assessments', 'lab_orders', 'imaging_orders',
    'medication_orders', 'billing_items'
  )
ORDER BY t.relname, c.conname;
