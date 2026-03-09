-- ============================================================
-- FIX 14 — HIGH: Admission Diagnosis FKs + Ward Bed Counter View
-- ============================================================
-- Problems:
--   1. admissions.admitting_diagnosis and discharge_diagnosis are TEXT
--      fields.  admitting_diagnosis_codes is TEXT[].  None link to the
--      diagnoses table, making ICD-coded admission reporting impossible.
--
--   2. wards.available_beds, occupied_beds, cleaning_beds are integer
--      counters that must be manually maintained.  No trigger keeps them
--      in sync with the actual beds table state, causing drift.
--
-- Fix:
--   Part A — Add admitting_diagnosis_id and discharge_diagnosis_id UUID FKs
--             to admissions. Keep text fields for backward compat.
--             Back-fill by matching icd10_code where possible.
--   Part B — Create view v_ward_bed_counts replacing the stale counters.
--             Add trigger on beds table to keep ward counters in sync.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- PART A: Admission diagnosis FK columns
-- ══════════════════════════════════════════════

ALTER TABLE public.admissions
  ADD COLUMN IF NOT EXISTS admitting_diagnosis_id  UUID REFERENCES public.diagnoses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discharge_diagnosis_id  UUID REFERENCES public.diagnoses(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.admissions.admitting_diagnosis_id IS
  'FK to diagnoses table. Preferred over admitting_diagnosis TEXT. '
  'Enables ICD-coded admission reporting and disease burden analysis.';
COMMENT ON COLUMN public.admissions.discharge_diagnosis_id IS
  'FK to diagnoses table. Preferred over discharge_diagnosis TEXT. '
  'Required for DRG-based costing and national HMIS reporting.';

-- Index for diagnosis-based admission queries
CREATE INDEX IF NOT EXISTS idx_admissions_admitting_dx
  ON public.admissions(admitting_diagnosis_id)
  WHERE admitting_diagnosis_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admissions_discharge_dx
  ON public.admissions(discharge_diagnosis_id)
  WHERE discharge_diagnosis_id IS NOT NULL;

-- Back-fill: link existing admissions to diagnoses rows for the same visit
-- where the ICD code or display name matches the free-text field.
DO $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- Match on visit_id + admitting diagnosis text → diagnoses.display_name
  UPDATE public.admissions a
  SET admitting_diagnosis_id = d.id
  FROM public.diagnoses d
  WHERE d.visit_id = a.source_visit_id
    AND admitting_diagnosis_id IS NULL
    AND a.admitting_diagnosis IS NOT NULL
    AND (
      LOWER(d.display_name) = LOWER(a.admitting_diagnosis)
      OR (a.admitting_diagnosis_codes IS NOT NULL
          AND d.icd10_code = ANY(a.admitting_diagnosis_codes))
    )
    AND d.deleted_at IS NULL
    AND d.diagnosis_type IN ('admitting','provisional','confirmed');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Back-filled % admitting_diagnosis_id links.', v_count;

  UPDATE public.admissions a
  SET discharge_diagnosis_id = d.id
  FROM public.diagnoses d
  WHERE d.visit_id = a.source_visit_id
    AND discharge_diagnosis_id IS NULL
    AND a.discharge_diagnosis IS NOT NULL
    AND (
      LOWER(d.display_name) = LOWER(a.discharge_diagnosis)
      OR (a.discharge_diagnosis_codes IS NOT NULL
          AND d.icd10_code = ANY(a.discharge_diagnosis_codes))
    )
    AND d.deleted_at IS NULL
    AND d.diagnosis_type IN ('discharge','confirmed');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'Back-filled % discharge_diagnosis_id links.', v_count;
END
$$;

-- ══════════════════════════════════════════════
-- PART B: Ward bed counters — computed view + sync trigger
-- ══════════════════════════════════════════════

-- Step 1: Accurate computed view (replaces stale integer counters)
CREATE OR REPLACE VIEW public.v_ward_bed_counts AS
SELECT
  b.ward_id,
  b.facility_id,
  COUNT(*)                                                         AS total_beds,
  COUNT(*) FILTER (WHERE b.status = 'AVAILABLE')                   AS available_beds,
  COUNT(*) FILTER (WHERE b.status = 'OCCUPIED')                    AS occupied_beds,
  COUNT(*) FILTER (WHERE b.status = 'CLEANING')                    AS cleaning_beds,
  COUNT(*) FILTER (WHERE b.status = 'MAINTENANCE')                 AS maintenance_beds,
  COUNT(*) FILTER (WHERE b.status = 'RESERVED')                    AS reserved_beds,
  ROUND(
    COUNT(*) FILTER (WHERE b.status = 'OCCUPIED')::NUMERIC
    / NULLIF(COUNT(*), 0) * 100, 1
  )                                                                AS occupancy_pct
FROM public.beds b
WHERE b.is_active = TRUE
GROUP BY b.ward_id, b.facility_id;

COMMENT ON VIEW public.v_ward_bed_counts IS
  'Real-time ward bed counts derived from the beds table. '
  'Use this instead of the denormalized counter columns on wards.';

-- Step 2: Trigger to keep ward counter columns in sync
--         (maintained for backward compatibility with code reading wards.available_beds)
CREATE OR REPLACE FUNCTION public.sync_ward_bed_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ward_id UUID;
BEGIN
  -- Determine affected ward
  IF TG_OP = 'DELETE' THEN
    v_ward_id := OLD.ward_id;
  ELSE
    v_ward_id := NEW.ward_id;
    -- Also update old ward if moved
    IF TG_OP = 'UPDATE' AND OLD.ward_id IS DISTINCT FROM NEW.ward_id THEN
      UPDATE public.wards w
      SET
        total_beds     = v2.total_beds,
        available_beds = v2.available_beds,
        occupied_beds  = v2.occupied_beds,
        cleaning_beds  = v2.cleaning_beds,
        updated_at     = now()
      FROM public.v_ward_bed_counts v2
      WHERE w.id = OLD.ward_id AND v2.ward_id = OLD.ward_id;
    END IF;
  END IF;

  UPDATE public.wards w
  SET
    total_beds     = v2.total_beds,
    available_beds = v2.available_beds,
    occupied_beds  = v2.occupied_beds,
    cleaning_beds  = v2.cleaning_beds,
    updated_at     = now()
  FROM public.v_ward_bed_counts v2
  WHERE w.id = v_ward_id AND v2.ward_id = v_ward_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_ward_bed_counters failed: % %', SQLSTATE, SQLERRM;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_ward_counters ON public.beds;

CREATE TRIGGER trg_sync_ward_counters
  AFTER INSERT OR UPDATE OF status, ward_id, is_active OR DELETE
  ON public.beds
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_ward_bed_counters();

-- Step 3: Fix beds.current_admission_id — add FK constraint (if column exists)
DO $$
BEGIN
  -- Only add the FK if the column exists on the remote schema
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'beds'
      AND column_name = 'current_admission_id'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.beds'::regclass
        AND conname = 'beds_current_admission_id_fkey'
    ) THEN
      ALTER TABLE public.beds
        ADD CONSTRAINT beds_current_admission_id_fkey
        FOREIGN KEY (current_admission_id)
        REFERENCES public.admissions(id)
        ON DELETE SET NULL;
      RAISE NOTICE 'Added beds_current_admission_id_fkey constraint.';
    ELSE
      RAISE NOTICE 'beds_current_admission_id_fkey already exists, skipping.';
    END IF;
  ELSE
    RAISE NOTICE 'beds.current_admission_id column does not exist — skipping FK.';
  END IF;
END
$$;

-- Step 4: Fix wards.department_id ON DELETE CASCADE → RESTRICT
--         (prevents silent ward deletion when a department is removed)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'wards'
      AND column_name = 'department_id'
  ) THEN
    -- Drop whichever FK name exists (name varies by migration history)
    ALTER TABLE public.wards DROP CONSTRAINT IF EXISTS wards_department_id_fkey;
    ALTER TABLE public.wards DROP CONSTRAINT IF EXISTS wards_department_id_fk;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.wards'::regclass
        AND conname = 'wards_department_id_fkey'
    ) THEN
      ALTER TABLE public.wards
        ADD CONSTRAINT wards_department_id_fkey
        FOREIGN KEY (department_id)
        REFERENCES public.departments(id)
        ON DELETE RESTRICT;
      RAISE NOTICE 'Re-created wards_department_id_fkey with ON DELETE RESTRICT.';
    END IF;
  ELSE
    RAISE NOTICE 'wards.department_id column does not exist — skipping FK.';
  END IF;
END
$$;

-- Step 3b: Ensure ward counter columns exist (added by early migration but may be absent on remote)
ALTER TABLE public.wards
  ADD COLUMN IF NOT EXISTS total_beds     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_beds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS occupied_beds  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleaning_beds  INTEGER NOT NULL DEFAULT 0;

-- Step 5: Sync current counters from live bed data
DO $$
BEGIN
  UPDATE public.wards w
  SET
    total_beds     = COALESCE(v2.total_beds,     0),
    available_beds = COALESCE(v2.available_beds, 0),
    occupied_beds  = COALESCE(v2.occupied_beds,  0),
    cleaning_beds  = COALESCE(v2.cleaning_beds,  0),
    updated_at     = now()
  FROM public.v_ward_bed_counts v2
  WHERE w.id = v2.ward_id;

  RAISE NOTICE 'Re-synchronised ward bed counters from beds table.';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Ward counter sync failed: % %', SQLSTATE, SQLERRM;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  'admissions with diagnosis FK' AS check_name,
  COUNT(*) FILTER (WHERE admitting_diagnosis_id IS NOT NULL) AS with_fk,
  COUNT(*) FILTER (WHERE admitting_diagnosis IS NOT NULL AND admitting_diagnosis_id IS NULL) AS text_only,
  COUNT(*) AS total
FROM public.admissions;

SELECT ward_id, total_beds, available_beds, occupied_beds
FROM public.v_ward_bed_counts
LIMIT 5;
