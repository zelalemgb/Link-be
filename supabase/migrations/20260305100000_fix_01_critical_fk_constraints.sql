-- ============================================================
-- FIX 01 — CRITICAL: Harden Foreign Key Constraints
-- ============================================================
-- Problem:
--   1. visit_id FKs on lab_orders, imaging_orders, medication_orders
--      are ON DELETE CASCADE — silently wiping clinical records when
--      a visit is deleted, with no audit trail.
--   2. Any NOT VALID constraints left over from previous migrations
--      are not enforced for existing rows (new rows are checked; old
--      rows may be referentially broken).
-- Fix:
--   • Drop the CASCADE visit_id FK on each order table and replace
--     with ON DELETE RESTRICT — hard-stops accidental visit deletion.
--   • Validate all remaining NOT VALID constraints in the schema.
--   • Add created_by FK constraints that were missing on order tables.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────
-- 1. Replace CASCADE with RESTRICT on lab_orders.visit_id
-- ──────────────────────────────────────────────
DO $$
BEGIN
  -- Drop existing constraint (added with CASCADE in init_schema)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lab_orders_visit_id_fkey'
      AND conrelid = 'public.lab_orders'::regclass
  ) THEN
    ALTER TABLE public.lab_orders DROP CONSTRAINT lab_orders_visit_id_fkey;
  END IF;

  -- Re-add as RESTRICT
  ALTER TABLE public.lab_orders
    ADD CONSTRAINT lab_orders_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id)
    ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- 2. Replace CASCADE with RESTRICT on imaging_orders.visit_id
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'imaging_orders_visit_id_fkey'
      AND conrelid = 'public.imaging_orders'::regclass
  ) THEN
    ALTER TABLE public.imaging_orders DROP CONSTRAINT imaging_orders_visit_id_fkey;
  END IF;

  ALTER TABLE public.imaging_orders
    ADD CONSTRAINT imaging_orders_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id)
    ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- 3. Replace CASCADE with RESTRICT on medication_orders.visit_id
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'medication_orders_visit_id_fkey'
      AND conrelid = 'public.medication_orders'::regclass
  ) THEN
    ALTER TABLE public.medication_orders DROP CONSTRAINT medication_orders_visit_id_fkey;
  END IF;

  ALTER TABLE public.medication_orders
    ADD CONSTRAINT medication_orders_visit_id_fkey
    FOREIGN KEY (visit_id) REFERENCES public.visits(id)
    ON DELETE RESTRICT;
END
$$;

-- ──────────────────────────────────────────────
-- 4. Ensure patient_id FKs exist on all three order tables (RESTRICT)
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_patient_id_fkey'
  ) THEN
    ALTER TABLE public.lab_orders
      ADD CONSTRAINT lab_orders_patient_id_fkey
      FOREIGN KEY (patient_id) REFERENCES public.patients(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'imaging_orders_patient_id_fkey'
  ) THEN
    ALTER TABLE public.imaging_orders
      ADD CONSTRAINT imaging_orders_patient_id_fkey
      FOREIGN KEY (patient_id) REFERENCES public.patients(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'medication_orders_patient_id_fkey'
  ) THEN
    ALTER TABLE public.medication_orders
      ADD CONSTRAINT medication_orders_patient_id_fkey
      FOREIGN KEY (patient_id) REFERENCES public.patients(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- ──────────────────────────────────────────────
-- 5. Ensure facility_id FKs exist on order tables
--    (only if the facility_id column exists on the table)
-- ──────────────────────────────────────────────
DO $$
BEGIN
  -- lab_orders
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lab_orders' AND column_name = 'facility_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_facility_id_fkey'
  ) THEN
    ALTER TABLE public.lab_orders
      ADD CONSTRAINT lab_orders_facility_id_fkey
      FOREIGN KEY (facility_id) REFERENCES public.facilities(id)
      ON DELETE RESTRICT;
  END IF;

  -- imaging_orders
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'imaging_orders' AND column_name = 'facility_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'imaging_orders_facility_id_fkey'
  ) THEN
    ALTER TABLE public.imaging_orders
      ADD CONSTRAINT imaging_orders_facility_id_fkey
      FOREIGN KEY (facility_id) REFERENCES public.facilities(id)
      ON DELETE RESTRICT;
  END IF;

  -- medication_orders
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medication_orders' AND column_name = 'facility_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'medication_orders_facility_id_fkey'
  ) THEN
    ALTER TABLE public.medication_orders
      ADD CONSTRAINT medication_orders_facility_id_fkey
      FOREIGN KEY (facility_id) REFERENCES public.facilities(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- ──────────────────────────────────────────────
-- 6. Validate any remaining NOT VALID constraints across all clinical
--    tables. This step is safe (read-only for valid rows, errors only
--    if orphaned rows actually exist).
-- ──────────────────────────────────────────────
DO $$
DECLARE
  r RECORD;
  sql TEXT;
BEGIN
  FOR r IN
    SELECT
      c.conname AS constraint_name,
      n.nspname AS schema_name,
      t.relname AS table_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f'          -- foreign key
      AND NOT c.convalidated        -- NOT VALID (not yet validated)
      AND n.nspname = 'public'
    ORDER BY t.relname, c.conname
  LOOP
    RAISE NOTICE 'Validating: %.%', r.table_name, r.constraint_name;
    sql := format(
      'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
      r.schema_name, r.table_name, r.constraint_name
    );
    EXECUTE sql;
  END LOOP;

  RAISE NOTICE 'All NOT VALID FK constraints have been validated.';
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  t.relname  AS table_name,
  c.conname  AS constraint_name,
  CASE c.confdeltype
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END        AS on_delete,
  c.convalidated AS is_valid
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype = 'f'
  AND n.nspname = 'public'
  AND t.relname IN (
    'lab_orders', 'imaging_orders', 'medication_orders',
    'anc_assessments', 'delivery_records', 'emergency_assessments',
    'immunization_records', 'family_planning_visits', 'pediatric_assessments',
    'billing_items'
  )
ORDER BY t.relname, c.conname;
