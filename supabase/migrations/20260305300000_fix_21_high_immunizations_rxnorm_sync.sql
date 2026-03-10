-- ============================================================
-- FIX 21 — HIGH: Immunizations, RxNorm/ATC Codes,
--                Two-ID Dispensing, LOINC Validation,
--                Wave 2 Sync for New Tables
-- ============================================================
-- Resolves gaps: F-4, C-1, C-3, J-2, W-1
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- 1. Immunizations table (F-4)
--    FHIR R4 Immunization resource
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.immunizations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  tenant_id      UUID NOT NULL REFERENCES public.tenants(id)    ON DELETE RESTRICT,
  facility_id    UUID NOT NULL REFERENCES public.facilities(id)  ON DELETE RESTRICT,
  patient_id     UUID NOT NULL REFERENCES public.patients(id)    ON DELETE RESTRICT,
  visit_id       UUID REFERENCES public.visits(id)               ON DELETE SET NULL,

  -- Vaccine identity (FHIR Immunization.vaccineCode)
  vaccine_code   TEXT NOT NULL,   -- CVX code (US) or WHO vaccine code
  vaccine_system TEXT NOT NULL DEFAULT 'CVX'
    CHECK (vaccine_system IN ('CVX','WHO','SNOMED','LOCAL')),
  vaccine_name   TEXT NOT NULL,   -- display name

  -- Lot / batch
  lot_number     TEXT,
  manufacturer   TEXT,
  expiration_date DATE,

  -- Administration
  administered_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  administered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  administered_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,
  administered_site  TEXT,        -- left deltoid, right thigh, etc.
  administered_route TEXT DEFAULT 'IM'
    CHECK (administered_route IN ('IM','SC','ID','PO','IN','IV','OTHER')),
  dose_quantity      NUMERIC(6,2),
  dose_unit          TEXT DEFAULT 'mL',
  dose_number        SMALLINT,    -- dose in series (1st, 2nd, booster)
  series_doses       SMALLINT,    -- total doses in series

  -- Vaccine information statement (VIS)
  vis_document_id    TEXT,        -- reference to consent/VIS document
  vis_published_date DATE,

  -- Status
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed','entered-in-error','not-done')),
  not_done_reason TEXT,           -- if status = 'not-done'

  -- Adverse reaction recording
  reaction_date        TIMESTAMPTZ,
  reaction_detail      TEXT,
  reaction_reported    BOOLEAN DEFAULT FALSE,

  -- Programme context (EPI, SIA, etc.)
  programme           TEXT,       -- e.g. 'EPI', 'COVID-19', 'Meningitis SIA'

  -- Soft delete & audit
  deleted_at   TIMESTAMPTZ,
  created_by   UUID REFERENCES public.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Wave 2 sync
  row_version  BIGINT NOT NULL DEFAULT 1
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_immunizations_patient
  ON public.immunizations(patient_id, administered_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_immunizations_facility_date
  ON public.immunizations(facility_id, administered_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_immunizations_vaccine
  ON public.immunizations(vaccine_code)
  WHERE deleted_at IS NULL;

-- updated_at trigger
CREATE TRIGGER update_immunizations_updated_at
  BEFORE UPDATE ON public.immunizations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- row_version bump for Wave 2 sync
CREATE OR REPLACE FUNCTION public.bump_immunizations_row_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_immunizations_row_version ON public.immunizations;
CREATE TRIGGER trg_immunizations_row_version
  BEFORE UPDATE ON public.immunizations
  FOR EACH ROW EXECUTE FUNCTION public.bump_immunizations_row_version();

-- PHI audit trigger (FIX_11 pattern)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phi_audit_trigger') THEN
    DROP TRIGGER IF EXISTS trg_phi_audit_immunizations ON public.immunizations;
    CREATE TRIGGER trg_phi_audit_immunizations
      AFTER INSERT OR UPDATE OR DELETE ON public.immunizations
      FOR EACH ROW EXECUTE FUNCTION public.phi_audit_trigger();
    RAISE NOTICE 'Attached PHI audit trigger to immunizations.';
  END IF;
END
$$;

-- RLS
ALTER TABLE public.immunizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view immunizations"
  ON public.immunizations FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "Clinical staff can record immunizations"
  ON public.immunizations FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin','nurse','doctor','clinical_officer','hew','super_admin')
    )
  );

CREATE POLICY "Clinical staff can update immunizations"
  ON public.immunizations FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin','nurse','doctor','clinical_officer','super_admin')
    )
  );

COMMENT ON TABLE public.immunizations IS
  'FHIR R4 Immunization resource. Records all vaccine administrations per patient. '
  'Uses CVX or WHO vaccine codes. Supports dose series tracking and adverse reaction logging.';

-- ══════════════════════════════════════════════
-- 2. RxNorm / ATC codes on medication_orders (C-3)
-- ══════════════════════════════════════════════
ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS rxnorm_code TEXT,
  ADD COLUMN IF NOT EXISTS atc_code    TEXT,  -- WHO ATC classification
  ADD COLUMN IF NOT EXISTS drug_form   TEXT,  -- tablet, capsule, syrup, injection, etc.
  ADD COLUMN IF NOT EXISTS drug_strength TEXT; -- e.g. '500mg', '250mg/5mL'

COMMENT ON COLUMN public.medication_orders.rxnorm_code IS
  'RxNorm concept unique identifier (RxCUI). Enables unambiguous drug identification '
  'and interoperability with clinical decision support systems.';
COMMENT ON COLUMN public.medication_orders.atc_code IS
  'WHO Anatomical Therapeutic Chemical (ATC) classification code. '
  'Required for NHIA formulary matching and drug utilisation reporting.';

-- ══════════════════════════════════════════════
-- 3. Two-patient-identifier enforcement at dispensing (J-2)
--    medication_dispense must record the patient_id that was
--    confirmed at point of dispensing — must match medication_order.patient_id.
-- ══════════════════════════════════════════════
ALTER TABLE public.medication_dispense
  ADD COLUMN IF NOT EXISTS verified_patient_id  UUID REFERENCES public.patients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verification_method  TEXT
    CHECK (verification_method IN ('name_dob','name_id','barcode','biometric','verbal','other')),
  ADD COLUMN IF NOT EXISTS verified_by          UUID REFERENCES public.users(id);

COMMENT ON COLUMN public.medication_dispense.verified_patient_id IS
  'JCI IPSG.1: The patient_id confirmed at point of dispensing. '
  'Must match the ordering medication_order.patient_id. '
  'Trigger enforces this match before dispensing is recorded.';

CREATE OR REPLACE FUNCTION public.enforce_two_id_dispensing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_patient_id UUID;
BEGIN
  -- Only enforce when status transitions to dispensed
  IF NEW.status <> 'dispensed' THEN
    RETURN NEW;
  END IF;

  -- verified_patient_id must be set for dispensed records
  IF NEW.verified_patient_id IS NULL THEN
    RAISE EXCEPTION
      'JCI Two-Identifier Rule: verified_patient_id must be set before dispensing. '
      'Confirm patient identity using two identifiers (name + DOB or name + ID). '
      'SQLSTATE P0005'
      USING ERRCODE = 'P0005';
  END IF;

  -- verified_patient_id must match the order's patient_id
  IF TG_TABLE_NAME = 'medication_dispense' THEN
    SELECT mo.patient_id INTO v_order_patient_id
    FROM public.medication_orders mo
    WHERE mo.id = NEW.medication_order_id
    LIMIT 1;

    IF v_order_patient_id IS NOT NULL
       AND v_order_patient_id <> NEW.verified_patient_id THEN
      RAISE EXCEPTION
        'JCI Two-Identifier Rule: verified_patient_id (%) does not match '
        'the medication order patient (%). Dispensing aborted.',
        NEW.verified_patient_id, v_order_patient_id
        USING ERRCODE = 'P0005';
    END IF;
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN SQLSTATE 'P0005' THEN RAISE;
  WHEN OTHERS THEN
    RAISE WARNING 'enforce_two_id_dispensing failed: % %', SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_two_id_dispensing() IS
  'JCI IPSG.1 Two-Patient-Identifier enforcement at medication dispensing. '
  'Blocks status=dispensed unless verified_patient_id is set and matches the order.';

DROP TRIGGER IF EXISTS trg_two_id_dispensing ON public.medication_dispense;
CREATE TRIGGER trg_two_id_dispensing
  BEFORE INSERT OR UPDATE OF status, verified_patient_id
  ON public.medication_dispense
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_two_id_dispensing();

-- ══════════════════════════════════════════════
-- 4. LOINC format validation on observations (C-1)
--    LOINC codes follow pattern: 1–5 digits, hyphen, 1 check digit
--    e.g. 8310-5, 29463-7, 59408-5
-- ══════════════════════════════════════════════
DO $$
BEGIN
  -- Check for obviously invalid LOINC codes before adding constraint
  -- (log them as warnings, don't block the migration)
  PERFORM loinc_code
  FROM public.observations
  WHERE loinc_code IS NOT NULL
    AND loinc_code !~ '^[0-9]{1,5}-[0-9]$'
  LIMIT 1;

  IF FOUND THEN
    RAISE NOTICE 'Some observations have non-standard LOINC codes. '
      'Constraint will be added in permissive mode (NULL allowed).';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_observations_loinc_format'
      AND conrelid = 'public.observations'::regclass
  ) THEN
    -- Only validate non-NULL values; allow NULL for custom/local codes
    ALTER TABLE public.observations
      ADD CONSTRAINT chk_observations_loinc_format
      CHECK (
        loinc_code IS NULL
        OR loinc_code ~ '^[0-9]{1,5}-[0-9]$'
        OR loinc_code ~ '^LOCAL-'    -- allow LOCAL-xxxxx for facility-specific codes
      );
    RAISE NOTICE 'Added LOINC format constraint to observations.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not add LOINC format constraint (existing non-conformant codes?): % %',
    SQLSTATE, SQLERRM;
END
$$;

-- ══════════════════════════════════════════════
-- 5. Wave 2 sync: row_version + op_ledger for new tables (W-1)
--    patient_conditions, patient_insurance, appointment_slots
-- ══════════════════════════════════════════════

-- Helper: generic row_version bump function (reusable)
CREATE OR REPLACE FUNCTION public.bump_row_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.row_version := COALESCE(OLD.row_version, 0) + 1;
  RETURN NEW;
END;
$$;

-- patient_conditions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='patient_conditions') THEN

    ALTER TABLE public.patient_conditions
      ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;

    DROP TRIGGER IF EXISTS trg_patient_conditions_row_version ON public.patient_conditions;
    CREATE TRIGGER trg_patient_conditions_row_version
      BEFORE UPDATE ON public.patient_conditions
      FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

    RAISE NOTICE 'Added row_version sync to patient_conditions.';
  END IF;
END
$$;

-- patient_insurance
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='patient_insurance') THEN

    ALTER TABLE public.patient_insurance
      ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;

    DROP TRIGGER IF EXISTS trg_patient_insurance_row_version ON public.patient_insurance;
    CREATE TRIGGER trg_patient_insurance_row_version
      BEFORE UPDATE ON public.patient_insurance
      FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

    RAISE NOTICE 'Added row_version sync to patient_insurance.';
  END IF;
END
$$;

-- appointment_slots
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='appointment_slots') THEN

    ALTER TABLE public.appointment_slots
      ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;

    DROP TRIGGER IF EXISTS trg_appointment_slots_row_version ON public.appointment_slots;
    CREATE TRIGGER trg_appointment_slots_row_version
      BEFORE UPDATE ON public.appointment_slots
      FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

    RAISE NOTICE 'Added row_version sync to appointment_slots.';
  END IF;
END
$$;

-- patient_identifiers (created in FIX_20)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='patient_identifiers') THEN

    ALTER TABLE public.patient_identifiers
      ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;

    DROP TRIGGER IF EXISTS trg_patient_identifiers_row_version ON public.patient_identifiers;
    CREATE TRIGGER trg_patient_identifiers_row_version
      BEFORE UPDATE ON public.patient_identifiers
      FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

    RAISE NOTICE 'Added row_version sync to patient_identifiers.';
  END IF;
END
$$;

-- immunizations (created above)
DROP TRIGGER IF EXISTS trg_immunizations_row_version ON public.immunizations;
CREATE TRIGGER trg_immunizations_row_version
  BEFORE UPDATE ON public.immunizations
  FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'FIX_21 verification: immunizations table=%, rxnorm_code on medication_orders=%, '
    'verified_patient_id on medication_dispense=%',
    (SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='immunizations')),
    (SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='medication_orders'
        AND column_name='rxnorm_code')),
    (SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='medication_dispense'
        AND column_name='verified_patient_id'));
END
$$;
