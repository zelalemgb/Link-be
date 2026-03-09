-- ============================================================
-- FIX 15 — HIGH: Patient Conditions (Longitudinal Problem List) +
--                Mother-Child Linkage
-- ============================================================
-- Problems:
--   1. diagnoses records visit-specific episodes only.  There is no
--      longitudinal problem list for conditions persisting across
--      visits (hypertension, diabetes, HIV, TB, epilepsy, CKD).
--      Clinicians cannot see a patient's ongoing conditions at a glance
--      without scanning all previous visits.
--
--   2. delivery_records has no link to the newborn patient record.
--      For paediatric follow-up and national HMIS reporting, the
--      mother–child relationship must be stored.
--
-- Fix:
--   Part A — patient_conditions table (FHIR Condition, problem list).
--             Back-fill from diagnoses where clinical_status = 'active'
--             and diagnosis_type IN ('confirmed', 'secondary').
--   Part B — Add mother_patient_id to patients.
--             Add newborn_patient_id to delivery_records.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- PART A: patient_conditions (longitudinal problem list)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.patient_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  tenant_id     UUID NOT NULL REFERENCES public.tenants(id),
  facility_id   UUID NOT NULL REFERENCES public.facilities(id),
  patient_id    UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  -- Coding (FHIR Condition)
  icd10_code    TEXT,
  icd11_code    TEXT,
  snomed_code   TEXT,
  display_name  TEXT NOT NULL,

  -- Classification
  condition_type TEXT NOT NULL DEFAULT 'chronic'
    CHECK (condition_type IN (
      'chronic',           -- ongoing long-term condition
      'acute',             -- self-limiting episode tracked longitudinally
      'family_history',    -- documented family history
      'surgical_history',  -- past surgical procedures
      'obstetric_history'  -- past pregnancy / obstetric events
    )),

  -- Status (FHIR Condition.clinicalStatus)
  clinical_status TEXT NOT NULL DEFAULT 'active'
    CHECK (clinical_status IN (
      'active',       -- currently affecting patient
      'recurrence',   -- returned after remission
      'relapse',
      'inactive',
      'remission',
      'resolved'
    )),

  -- Verification (FHIR Condition.verificationStatus)
  verification_status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (verification_status IN (
      'unconfirmed',
      'provisional',
      'confirmed',
      'refuted',
      'entered_in_error'
    )),

  -- Severity
  severity TEXT CHECK (severity IN ('mild', 'moderate', 'severe')),

  -- Timeline
  onset_date      DATE,
  onset_age_years INTEGER,
  resolution_date DATE,

  -- Source visit (when first diagnosed)
  source_visit_id   UUID REFERENCES public.visits(id) ON DELETE SET NULL,
  source_diagnosis_id UUID REFERENCES public.diagnoses(id) ON DELETE SET NULL,

  -- Clinical notes
  notes TEXT,

  -- Audit
  recorded_by UUID NOT NULL REFERENCES public.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ   -- soft-delete

  -- No unique constraint: a patient can have the same condition recorded
  -- from multiple facilities (e.g., referral chain).
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pc_patient_status
  ON public.patient_conditions(patient_id, clinical_status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pc_patient_type
  ON public.patient_conditions(patient_id, condition_type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pc_icd10
  ON public.patient_conditions(icd10_code)
  WHERE icd10_code IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pc_facility_active
  ON public.patient_conditions(facility_id, clinical_status, condition_type)
  WHERE deleted_at IS NULL;

-- Full-text search on condition name
CREATE INDEX IF NOT EXISTS idx_pc_fts
  ON public.patient_conditions
  USING GIN (to_tsvector('english', display_name));

-- Trigger
CREATE TRIGGER update_patient_conditions_updated_at
  BEFORE UPDATE ON public.patient_conditions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.patient_conditions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view patient conditions"
  ON public.patient_conditions FOR SELECT
  USING (
    facility_id = public.get_user_facility_id()
    AND deleted_at IS NULL
  );

CREATE POLICY "Clinical staff can create patient conditions"
  ON public.patient_conditions FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_clinical_staff()
  );

CREATE POLICY "Clinical staff can update patient conditions"
  ON public.patient_conditions FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND public.is_clinical_staff()
  );

-- Back-fill from diagnoses
DO $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  INSERT INTO public.patient_conditions (
    tenant_id, facility_id, patient_id,
    icd10_code, icd11_code, snomed_code, display_name,
    condition_type, clinical_status, verification_status,
    onset_date, source_visit_id, source_diagnosis_id,
    recorded_by, created_at, updated_at
  )
  SELECT DISTINCT ON (d.patient_id, d.display_name)
    d.tenant_id, d.facility_id, d.patient_id,
    d.icd10_code, d.icd11_code, d.snomed_code, d.display_name,
    'chronic'   AS condition_type,
    d.clinical_status,
    d.certainty AS verification_status,
    v.visit_date AS onset_date,
    d.visit_id   AS source_visit_id,
    d.id         AS source_diagnosis_id,
    COALESCE(d.created_by,
      (SELECT id FROM public.users ORDER BY created_at LIMIT 1)) AS recorded_by,
    d.created_at,
    d.updated_at
  FROM public.diagnoses d
  LEFT JOIN public.visits v ON v.id = d.visit_id
  WHERE d.deleted_at IS NULL
    AND d.clinical_status IN ('active', 'recurrence', 'relapse')
    AND d.diagnosis_type IN ('confirmed', 'secondary', 'discharge')
    AND NOT EXISTS (
      SELECT 1 FROM public.patient_conditions pc
      WHERE pc.patient_id = d.patient_id
        AND pc.source_diagnosis_id = d.id
    )
  ORDER BY d.patient_id, d.display_name, d.created_at DESC;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'Back-filled % patient_conditions rows from diagnoses.', v_inserted;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'patient_conditions back-fill skipped: % %', SQLSTATE, SQLERRM;
END
$$;

-- ══════════════════════════════════════════════
-- PART B: Mother-child linkage
-- ══════════════════════════════════════════════

-- Add mother_patient_id to patients (FK to self)
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS mother_patient_id UUID
    REFERENCES public.patients(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.patients.mother_patient_id IS
  'FK to patients.id of the mother. Set for newborns registered via '
  'delivery_records. Enables paediatric follow-up and HMIS mother-child '
  'linkage reports.';

CREATE INDEX IF NOT EXISTS idx_patients_mother
  ON public.patients(mother_patient_id)
  WHERE mother_patient_id IS NOT NULL;

-- Add newborn_patient_id to delivery_records
ALTER TABLE public.delivery_records
  ADD COLUMN IF NOT EXISTS newborn_patient_id UUID
    REFERENCES public.patients(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.delivery_records.newborn_patient_id IS
  'FK to the newborn''s patients.id. Populated when the newborn is '
  'registered as a patient after delivery. Required for HMIS linkage.';

CREATE INDEX IF NOT EXISTS idx_delivery_records_newborn
  ON public.delivery_records(newborn_patient_id)
  WHERE newborn_patient_id IS NOT NULL;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  'patient_conditions' AS table_name,
  COUNT(*)             AS total_rows,
  COUNT(*) FILTER (WHERE clinical_status = 'active') AS active
FROM public.patient_conditions;
