-- =============================================================================
-- STAGING SCRIPT — W2-DB-022: Wave 2 Patient + Visit Field Extensions
-- Paste this entire file into the Supabase Dashboard → SQL Editor and run.
-- Safe to run multiple times (idempotent — all statements use IF NOT EXISTS /
-- OR REPLACE / IF column EXISTS patterns).
-- =============================================================================
-- DEPENDS ON: W2-DB-021 (deleted_at, row_version, triggers, indexes) applied first.
-- =============================================================================

-- ─── PATIENTS ─────────────────────────────────────────────────────────────────

-- Make legacy columns nullable so new W2 inserts don't have to supply them
ALTER TABLE public.patients ALTER COLUMN age    DROP NOT NULL;
ALTER TABLE public.patients ALTER COLUMN gender DROP NOT NULL;

-- W2 patient demographic fields
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS sex      TEXT
  CHECK (sex IN ('male', 'female', 'other', 'unknown'));
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS village  TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS kebele   TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS woreda   TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'am'
  CHECK (language IN ('am', 'om', 'en'));
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS hew_user_id UUID
  REFERENCES public.users(id) ON DELETE SET NULL;

-- Backfill: derive date_of_birth from age where DOB is unknown (approximate Jan 1)
UPDATE public.patients
SET date_of_birth = (DATE_TRUNC('year', NOW()) - (age || ' years')::INTERVAL)::DATE
WHERE age IS NOT NULL AND date_of_birth IS NULL;

-- ─── VISITS ───────────────────────────────────────────────────────────────────

-- Make legacy columns nullable (W2 flow uses chief_complaint + clinician_id)
ALTER TABLE public.visits ALTER COLUMN reason   DROP NOT NULL;
ALTER TABLE public.visits ALTER COLUMN provider DROP NOT NULL;

-- W2 clinical fields
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS visit_type TEXT NOT NULL DEFAULT 'outpatient'
  CHECK (visit_type IN ('outpatient', 'inpatient', 'emergency', 'antenatal', 'postnatal', 'immunisation', 'other'));
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS chief_complaint TEXT;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS clinician_id UUID
  REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS outcome TEXT
  CHECK (outcome IN ('discharged', 'admitted', 'referred', 'follow_up', 'deceased'));
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS follow_up_date DATE;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS notes TEXT;

-- JSONB structured clinical snapshots
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS vitals_json     JSONB;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS diagnoses_json  JSONB;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS treatments_json JSONB;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS referral_json   JSONB;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS assessment_json JSONB;

-- ─── Additional indexes ───────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_patients_hew_user
  ON public.patients (hew_user_id, facility_id)
  WHERE hew_user_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_patients_language
  ON public.patients (language, facility_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_visits_clinician
  ON public.visits (clinician_id, facility_id, visit_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_visits_outcome
  ON public.visits (outcome, facility_id, visit_date DESC)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- VERIFICATION — run after the above; all counts should match expected values
-- =============================================================================
SELECT
  -- Patient W2 columns (expect 7)
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'patients'
     AND column_name IN ('date_of_birth','sex','village','kebele','woreda','language','hew_user_id'))
   AS patient_w2_cols,   -- expected: 7

  -- Visit W2 columns (expect 10)
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'visits'
     AND column_name IN ('visit_type','chief_complaint','clinician_id','outcome','follow_up_date',
                         'notes','vitals_json','diagnoses_json','treatments_json','referral_json','assessment_json'))
   AS visit_w2_cols,     -- expected: 11 (notes is one of them)

  -- Legacy nullable check (expect 0 NOT NULL entries for these columns)
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'patients'
     AND column_name IN ('age','gender') AND is_nullable = 'NO')
   AS patients_legacy_still_not_null,  -- expected: 0

  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'visits'
     AND column_name IN ('reason','provider') AND is_nullable = 'NO')
   AS visits_legacy_still_not_null,    -- expected: 0

  -- W2 indexes (expect 4)
  (SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public'
     AND indexname IN (
       'idx_patients_hew_user', 'idx_patients_language',
       'idx_visits_clinician',  'idx_visits_outcome'))
   AS w2_index_count;    -- expected: 4
