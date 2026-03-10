-- ============================================================
-- FIX 02 — CRITICAL: Normalise Diagnoses
-- ============================================================
-- Problem:
--   Diagnoses are stored as free-text fields scattered across
--   tables (visits.provisional_diagnosis TEXT, emergency_assessments
--   .final_diagnosis TEXT, surgical_assessments.provisional_diagnosis,
--   etc.).  This prevents:
--     • ICD-10/ICD-11 coding and coding quality checks
--     • Distinguishing primary from secondary/differential diagnoses
--     • Certainty tracking (working vs. confirmed vs. ruled-out)
--     • Aggregate disease surveillance reporting
--     • FHIR Condition resource mapping
-- Fix:
--   Create a normalised public.diagnoses table keyed to (visit_id,
--   patient_id) with ICD codes, diagnosis type, certainty, and a
--   migration step that absorbs existing free-text values.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────
-- 1. Create diagnoses table
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.diagnoses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant / Facility scoping
  tenant_id         UUID NOT NULL REFERENCES public.tenants(id),
  facility_id       UUID NOT NULL REFERENCES public.facilities(id),

  -- Clinical context
  visit_id          UUID NOT NULL REFERENCES public.visits(id) ON DELETE RESTRICT,
  patient_id        UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  -- Coding
  icd10_code        TEXT,         -- e.g. "J18.9"
  icd11_code        TEXT,         -- e.g. "CA40.00"
  snomed_code       TEXT,         -- SNOMED CT concept ID (optional)
  display_name      TEXT NOT NULL, -- Human-readable label, always required

  -- Classification
  diagnosis_type    TEXT NOT NULL DEFAULT 'provisional'
    CHECK (diagnosis_type IN (
      'provisional',     -- working / suspected
      'confirmed',       -- clinician confirmed
      'differential',    -- one of several possibilities
      'ruled_out',       -- explicitly excluded
      'secondary',       -- co-morbidity
      'admitting',       -- diagnosis at admission
      'discharge'        -- final discharge diagnosis
    )),

  -- Certainty (maps to FHIR Condition.verificationStatus)
  certainty         TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (certainty IN (
      'unconfirmed',
      'provisional',
      'differential',
      'confirmed',
      'refuted',
      'entered_in_error'
    )),

  -- Clinical status (maps to FHIR Condition.clinicalStatus)
  clinical_status   TEXT NOT NULL DEFAULT 'active'
    CHECK (clinical_status IN (
      'active',
      'recurrence',
      'relapse',
      'inactive',
      'remission',
      'resolved'
    )),

  -- Ordering
  display_order     SMALLINT DEFAULT 0,  -- 0 = primary, 1 = secondary, etc.

  -- Source tracking
  source_table      TEXT,   -- e.g. 'visits', 'emergency_assessments'
  source_field      TEXT,   -- e.g. 'provisional_diagnosis'

  -- Audit
  created_by        UUID NOT NULL REFERENCES public.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ  -- soft-delete support
);

-- ──────────────────────────────────────────────
-- 2. Indexes
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_diagnoses_visit_id
  ON public.diagnoses(visit_id);

CREATE INDEX IF NOT EXISTS idx_diagnoses_patient_id
  ON public.diagnoses(patient_id);

CREATE INDEX IF NOT EXISTS idx_diagnoses_tenant_facility
  ON public.diagnoses(tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_diagnoses_icd10
  ON public.diagnoses(icd10_code)
  WHERE icd10_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_diagnoses_icd11
  ON public.diagnoses(icd11_code)
  WHERE icd11_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_diagnoses_type_status
  ON public.diagnoses(diagnosis_type, clinical_status);

-- Full-text search on display_name
CREATE INDEX IF NOT EXISTS idx_diagnoses_display_name_fts
  ON public.diagnoses USING GIN (to_tsvector('english', display_name));

-- ──────────────────────────────────────────────
-- 3. updated_at trigger
-- ──────────────────────────────────────────────
CREATE TRIGGER update_diagnoses_updated_at
  BEFORE UPDATE ON public.diagnoses
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ──────────────────────────────────────────────
-- 4. Enable RLS
-- ──────────────────────────────────────────────
ALTER TABLE public.diagnoses ENABLE ROW LEVEL SECURITY;

-- Read: any staff at the same facility
CREATE POLICY "Facility staff can view diagnoses"
  ON public.diagnoses FOR SELECT
  USING (facility_id = public.get_user_facility_id());

-- Insert: clinical staff only
CREATE POLICY "Clinical staff can create diagnoses"
  ON public.diagnoses FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('doctor', 'clinical_officer', 'nurse')
    )
  );

-- Update: clinical staff, own facility
CREATE POLICY "Clinical staff can update diagnoses"
  ON public.diagnoses FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('doctor', 'clinical_officer', 'nurse')
    )
  );

-- ──────────────────────────────────────────────
-- 5. Migrate existing free-text diagnoses from visits table
--    (provisional_diagnosis column if it exists)
-- ──────────────────────────────────────────────
DO $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  -- Check whether visits.provisional_diagnosis exists
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'visits'
      AND column_name  = 'provisional_diagnosis'
  ) INTO col_exists;

  IF col_exists THEN
    INSERT INTO public.diagnoses (
      tenant_id,
      facility_id,
      visit_id,
      patient_id,
      display_name,
      diagnosis_type,
      certainty,
      clinical_status,
      display_order,
      source_table,
      source_field,
      created_by,
      created_at,
      updated_at
    )
    SELECT
      v.tenant_id,
      v.facility_id,
      v.id            AS visit_id,
      v.patient_id,
      v.provisional_diagnosis AS display_name,
      'provisional'   AS diagnosis_type,
      'provisional'   AS certainty,
      'active'        AS clinical_status,
      0               AS display_order,
      'visits'        AS source_table,
      'provisional_diagnosis' AS source_field,
      v.created_by,
      v.created_at,
      v.updated_at
    FROM public.visits v
    WHERE v.provisional_diagnosis IS NOT NULL
      AND v.provisional_diagnosis <> ''
      -- Skip if a diagnosis row was already migrated for this visit
      AND NOT EXISTS (
        SELECT 1 FROM public.diagnoses d
        WHERE d.visit_id     = v.id
          AND d.source_table = 'visits'
          AND d.source_field = 'provisional_diagnosis'
      );

    RAISE NOTICE 'Migrated % provisional_diagnosis rows from visits.',
      (SELECT count(*) FROM public.diagnoses WHERE source_field = 'provisional_diagnosis');
  ELSE
    RAISE NOTICE 'visits.provisional_diagnosis column not found — skipping migration.';
  END IF;
END
$$;

-- ──────────────────────────────────────────────
-- 6. Migrate emergency_assessments.final_diagnosis
-- ──────────────────────────────────────────────
DO $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'emergency_assessments'
      AND column_name  = 'final_diagnosis'
  ) INTO col_exists;

  IF col_exists THEN
    INSERT INTO public.diagnoses (
      tenant_id,
      facility_id,
      visit_id,
      patient_id,
      display_name,
      diagnosis_type,
      certainty,
      clinical_status,
      display_order,
      source_table,
      source_field,
      created_by,
      created_at,
      updated_at
    )
    SELECT
      ea.tenant_id,
      ea.facility_id,
      ea.visit_id,
      ea.patient_id,
      ea.final_diagnosis,
      'confirmed',
      'confirmed',
      'active',
      0,
      'emergency_assessments',
      'final_diagnosis',
      ea.created_by,
      ea.created_at,
      ea.updated_at
    FROM public.emergency_assessments ea
    WHERE ea.final_diagnosis IS NOT NULL
      AND ea.final_diagnosis <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.diagnoses d
        WHERE d.visit_id     = ea.visit_id
          AND d.source_table = 'emergency_assessments'
          AND d.source_field = 'final_diagnosis'
      );

    RAISE NOTICE 'Migrated emergency_assessments.final_diagnosis rows.';
  END IF;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  diagnosis_type,
  certainty,
  clinical_status,
  source_table,
  count(*) AS row_count
FROM public.diagnoses
GROUP BY diagnosis_type, certainty, clinical_status, source_table
ORDER BY source_table, diagnosis_type;
