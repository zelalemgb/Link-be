-- =============================================================================
-- W2-DB-022: Wave 2 Patient + Visit Field Extensions
-- =============================================================================
--
-- The original patients/visits schema was designed for a web-first flow.
-- Wave 2 adds an Android-first offline EMR with a richer clinical model.
-- This migration extends both tables to accept the mobile's data model
-- so that sync push/pull (W2-03) can apply data to real columns rather
-- than losing fields on the server.
--
-- PATIENTS additions:
--   date_of_birth DATE              — replaces derived 'age'; age kept for compat
--   sex TEXT                        — 'male'|'female'|'other'|'unknown'
--   village / kebele / woreda TEXT  — sub-district address fields (Ethiopia)
--   language TEXT                   — preferred language 'am'|'om'|'en'
--   hew_user_id UUID                — assigned Health Extension Worker
--
-- VISITS additions:
--   visit_type TEXT                 — outpatient/emergency/antenatal etc.
--   chief_complaint TEXT            — replaces free-text 'reason'
--   clinician_id UUID               — auth user who conducted the visit
--   outcome TEXT                    — discharged/admitted/referred/follow_up/deceased
--   follow_up_date DATE
--   notes TEXT
--   vitals_json JSONB               — snapshot of visit_vitals row
--   diagnoses_json JSONB            — array of ICD-lite diagnosis objects
--   treatments_json JSONB           — array of treatment/drug objects
--   referral_json JSONB             — referral destination + urgency
--   assessment_json JSONB           — SOAP summary (S/O/A/P)
--
-- Compatibility notes:
--   • patients.age is made nullable (DOB is the authoritative source going forward)
--   • visits.reason and visits.provider are made nullable (replaced by
--     chief_complaint and clinician_id respectively in the W2 flow)
--
-- IDEMPOTENT: safe to run multiple times.
-- =============================================================================

BEGIN;

-- ─── PATIENTS ─────────────────────────────────────────────────────────────────

-- Make legacy columns nullable so new W2 inserts don't have to supply them
ALTER TABLE public.patients ALTER COLUMN age      DROP NOT NULL;
ALTER TABLE public.patients ALTER COLUMN gender   DROP NOT NULL;

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

-- Backfill: derive date_of_birth from age where DOB is unknown (approximate)
-- Sets DOB to Jan 1 of (current_year - age) for rows where age IS NOT NULL
UPDATE public.patients
SET date_of_birth = (DATE_TRUNC('year', NOW()) - (age || ' years')::INTERVAL)::DATE
WHERE age IS NOT NULL AND date_of_birth IS NULL;

COMMENT ON COLUMN public.patients.date_of_birth IS 'ISO date of birth; authoritative source for age calculation in W2+';
COMMENT ON COLUMN public.patients.sex            IS 'Biological sex for clinical relevance; male/female/other/unknown';
COMMENT ON COLUMN public.patients.village        IS 'Kebele-level village (Ethiopia address model)';
COMMENT ON COLUMN public.patients.kebele         IS 'Kebele administrative unit';
COMMENT ON COLUMN public.patients.woreda         IS 'Woreda administrative unit';
COMMENT ON COLUMN public.patients.language       IS 'Preferred consultation language: am=Amharic, om=Afaan Oromo, en=English';
COMMENT ON COLUMN public.patients.hew_user_id    IS 'Health Extension Worker assigned to this patient (users.id)';

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

-- Structured W2 clinical data as JSONB snapshots (normalised on mobile, flattened for server audit)
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS vitals_json     JSONB;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS diagnoses_json  JSONB;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS treatments_json JSONB;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS referral_json   JSONB;
ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS assessment_json JSONB;

COMMENT ON COLUMN public.visits.visit_type      IS 'Type of visit: outpatient, emergency, antenatal, etc.';
COMMENT ON COLUMN public.visits.chief_complaint IS 'Primary presenting complaint (W2 replaces reason)';
COMMENT ON COLUMN public.visits.clinician_id    IS 'Clinician who conducted the visit (users.id)';
COMMENT ON COLUMN public.visits.vitals_json     IS 'Snapshot: {bp_systolic, bp_diastolic, temp, hr, spo2, weight_kg, height_cm, muac_mm}';
COMMENT ON COLUMN public.visits.diagnoses_json  IS 'Array: [{icd_code, display_name, diagnosis_type, certainty}]';
COMMENT ON COLUMN public.visits.treatments_json IS 'Array: [{drug_name, dose, route, frequency, duration_days, quantity}]';
COMMENT ON COLUMN public.visits.referral_json   IS 'Object: {is_referred, destination, urgency, transport, reason}';
COMMENT ON COLUMN public.visits.assessment_json IS 'Object: {history_text, examination_text, assessment_text, plan_text}';

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

-- ─── Verification ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  _patient_cols INT;
  _visit_cols   INT;
BEGIN
  SELECT COUNT(*) INTO _patient_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'patients'
    AND column_name IN ('date_of_birth','sex','village','kebele','woreda','language','hew_user_id');

  SELECT COUNT(*) INTO _visit_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'visits'
    AND column_name IN ('visit_type','chief_complaint','clinician_id','outcome','follow_up_date',
                        'vitals_json','diagnoses_json','treatments_json','referral_json','assessment_json');

  RAISE NOTICE 'W2-DB-022: patient W2 columns = % / 7, visit W2 columns = % / 10',
    _patient_cols, _visit_cols;

  IF _patient_cols < 7 OR _visit_cols < 10 THEN
    RAISE EXCEPTION 'W2-DB-022 migration incomplete';
  END IF;
END;
$$;

COMMIT;
