-- ============================================================
-- FIX 03 — CRITICAL: Patient Allergies Table
-- ============================================================
-- Problem:
--   There is no structured allergies table. Allergy data is stored
--   as free-text strings in surgical_assessments.allergies and
--   similar fields. This is a PATIENT SAFETY issue:
--     • No alerting system for contraindicated medications
--     • No severity grading (mild vs. anaphylaxis)
--     • No audit trail for allergy updates
--     • Non-compliant with FHIR AllergyIntolerance resource
--     • Cannot integrate with pharmacy ordering systems
-- Fix:
--   Create public.patient_allergies with full FHIR-aligned structure,
--   RLS policies, and a migration step for existing free-text data.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────
-- 1. Create patient_allergies table
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.patient_allergies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant / Facility scoping
  tenant_id           UUID NOT NULL REFERENCES public.tenants(id),
  facility_id         UUID NOT NULL REFERENCES public.facilities(id),

  -- Subject
  patient_id          UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  -- Allergy identification
  allergen_name       TEXT NOT NULL,            -- Display name, always required
  allergen_code       TEXT,                     -- SNOMED / RxNorm code if known
  allergen_system     TEXT                      -- 'snomed' | 'rxnorm' | 'ndf-rt' | 'custom'
    CHECK (allergen_system IN ('snomed', 'rxnorm', 'ndf-rt', 'custom', NULL)),

  -- FHIR AllergyIntolerance.category
  allergen_category   TEXT NOT NULL DEFAULT 'medication'
    CHECK (allergen_category IN (
      'food',
      'medication',
      'environment',
      'biologic'
    )),

  -- FHIR AllergyIntolerance.type
  allergy_type        TEXT NOT NULL DEFAULT 'allergy'
    CHECK (allergy_type IN (
      'allergy',       -- immune-mediated
      'intolerance'    -- non-immune (side-effect / idiosyncratic)
    )),

  -- FHIR AllergyIntolerance.criticality
  criticality         TEXT NOT NULL DEFAULT 'low'
    CHECK (criticality IN (
      'low',           -- mild / nuisance
      'high',          -- life-threatening (anaphylaxis risk)
      'unable_to_assess'
    )),

  -- FHIR AllergyIntolerance.verificationStatus
  verification_status TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (verification_status IN (
      'unconfirmed',
      'presumed',
      'confirmed',
      'refuted',
      'entered_in_error'
    )),

  -- FHIR AllergyIntolerance.clinicalStatus
  clinical_status     TEXT NOT NULL DEFAULT 'active'
    CHECK (clinical_status IN (
      'active',
      'inactive',
      'resolved'
    )),

  -- Reaction details (simplified; one primary reaction per row)
  reaction_type       TEXT,   -- e.g. "Anaphylaxis", "Urticaria", "Rash"
  reaction_severity   TEXT
    CHECK (reaction_severity IN ('mild', 'moderate', 'severe', NULL)),
  reaction_description TEXT,  -- Free-text details

  -- Timeline
  onset_date          DATE,
  last_occurrence_date DATE,

  -- Recording context
  recorded_by         UUID NOT NULL REFERENCES public.users(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_by    UUID REFERENCES public.users(id),
  last_verified_at    TIMESTAMPTZ,

  -- Source tracking (for migrated data)
  source_table        TEXT,
  source_field        TEXT,
  notes               TEXT,

  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ   -- soft-delete
);

-- ──────────────────────────────────────────────
-- 2. Indexes
-- ──────────────────────────────────────────────
-- Primary lookup: all allergies for a patient
CREATE INDEX IF NOT EXISTS idx_patient_allergies_patient_id
  ON public.patient_allergies(patient_id)
  WHERE deleted_at IS NULL;

-- Tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_patient_allergies_tenant_facility
  ON public.patient_allergies(tenant_id, facility_id)
  WHERE deleted_at IS NULL;

-- Medication safety: find active, high-criticality medication allergies
CREATE INDEX IF NOT EXISTS idx_patient_allergies_active_medication
  ON public.patient_allergies(patient_id, allergen_category, criticality)
  WHERE deleted_at IS NULL
    AND clinical_status = 'active';

-- Allergen name search
CREATE INDEX IF NOT EXISTS idx_patient_allergies_name_fts
  ON public.patient_allergies
  USING GIN (to_tsvector('english', allergen_name));

-- ──────────────────────────────────────────────
-- 3. updated_at trigger
-- ──────────────────────────────────────────────
CREATE TRIGGER update_patient_allergies_updated_at
  BEFORE UPDATE ON public.patient_allergies
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ──────────────────────────────────────────────
-- 4. Enable RLS
-- ──────────────────────────────────────────────
ALTER TABLE public.patient_allergies ENABLE ROW LEVEL SECURITY;

-- Any facility staff can view (needed for medication safety checks)
CREATE POLICY "Facility staff can view patient allergies"
  ON public.patient_allergies FOR SELECT
  USING (
    facility_id = public.get_user_facility_id()
    AND deleted_at IS NULL
  );

-- Clinical staff can record allergies
CREATE POLICY "Clinical staff can create patient allergies"
  ON public.patient_allergies FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('doctor', 'clinical_officer', 'nurse', 'pharmacist')
    )
  );

-- Clinical staff can update (soft-delete, verification, correction)
CREATE POLICY "Clinical staff can update patient allergies"
  ON public.patient_allergies FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('doctor', 'clinical_officer', 'nurse', 'pharmacist')
    )
  );

-- ──────────────────────────────────────────────
-- 5. Migrate free-text allergies from surgical_assessments
-- ──────────────────────────────────────────────
DO $$
DECLARE
  col_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'surgical_assessments'
      AND column_name  = 'allergies'
  ) INTO col_exists;

  IF col_exists THEN
    INSERT INTO public.patient_allergies (
      tenant_id,
      facility_id,
      patient_id,
      allergen_name,
      allergen_category,
      allergy_type,
      criticality,
      verification_status,
      clinical_status,
      source_table,
      source_field,
      recorded_by,
      recorded_at,
      created_at,
      updated_at
    )
    SELECT DISTINCT ON (sa.patient_id, sa.allergies)
      sa.facility_id,                     -- will be mapped to tenant below
      sa.facility_id,
      sa.patient_id,
      sa.allergies,
      'medication',                        -- conservative default category
      'allergy',
      'unable_to_assess',                  -- severity unknown from free text
      'unconfirmed',
      'active',
      'surgical_assessments',
      'allergies',
      sa.created_by,
      sa.created_at,
      sa.created_at,
      sa.updated_at
    FROM public.surgical_assessments sa
    WHERE sa.allergies IS NOT NULL
      AND sa.allergies <> ''
      AND sa.allergies NOT ILIKE '%none%'
      AND sa.allergies NOT ILIKE '%nkda%'
      AND sa.allergies NOT ILIKE '%no known%'
      AND NOT EXISTS (
        SELECT 1 FROM public.patient_allergies pa
        WHERE pa.patient_id   = sa.patient_id
          AND pa.allergen_name = sa.allergies
          AND pa.source_table  = 'surgical_assessments'
      );

    RAISE NOTICE 'Migrated surgical_assessments allergy rows.';
  ELSE
    RAISE NOTICE 'surgical_assessments.allergies column not found — skipping.';
  END IF;
END
$$;

-- ──────────────────────────────────────────────
-- 6. Fix tenant_id on migrated rows (the insert above used facility_id
--    as a placeholder for tenant_id — correct it now)
-- ──────────────────────────────────────────────
UPDATE public.patient_allergies pa
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE f.id = pa.facility_id
  AND pa.source_table IS NOT NULL;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  clinical_status,
  allergen_category,
  criticality,
  source_table,
  count(*) AS row_count
FROM public.patient_allergies
GROUP BY clinical_status, allergen_category, criticality, source_table
ORDER BY source_table;
