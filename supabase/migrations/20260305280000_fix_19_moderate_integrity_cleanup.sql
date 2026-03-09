-- ============================================================
-- FIX 19 — MODERATE: Integrity Cleanup, Index Gaps & Deduplication
-- ============================================================
-- Covers:
--   a) Deduplicate insurers / creditors / programs (duplicate TABLE
--      definitions in init schema created two definition variants;
--      the second was silently ignored by IF NOT EXISTS, but the
--      inconsistency in constraint coverage must be addressed)
--   b) Add missing indexes: visits(patient_id), payment_journals
--      unposted partial index, diagnoses(icd10_code)
--   c) Normalise sex / gender fields on patients — add sex column
--      constraint alignment and back-fill from gender
--   d) medication_dispense → stock_movements linkage trigger
--   e) Link medication_dispense to stock when dispensed
--   f) Audit_log immutability enforcement
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- a) Deduplicate insurer / creditor / program definitions
--    Both definition variants used IF NOT EXISTS so the tables are
--    physically the same.  What's missing from some variants are:
--    - contact_info JSONB and metadata JSONB columns
--    - UNIQUE (tenant_id, facility_id, name) constraint
-- ══════════════════════════════════════════════

-- insurers
ALTER TABLE public.insurers
  ADD COLUMN IF NOT EXISTS contact_info JSONB,
  ADD COLUMN IF NOT EXISTS metadata     JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'insurers_tenant_id_facility_id_name_key'
      AND conrelid = 'public.insurers'::regclass
  ) THEN
    ALTER TABLE public.insurers
      ADD CONSTRAINT insurers_tenant_id_facility_id_name_key
      UNIQUE (tenant_id, facility_id, name);
  END IF;
END
$$;

-- creditors
ALTER TABLE public.creditors
  ADD COLUMN IF NOT EXISTS contact_info JSONB,
  ADD COLUMN IF NOT EXISTS metadata     JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'creditors_tenant_id_facility_id_name_key'
      AND conrelid = 'public.creditors'::regclass
  ) THEN
    ALTER TABLE public.creditors
      ADD CONSTRAINT creditors_tenant_id_facility_id_name_key
      UNIQUE (tenant_id, facility_id, name);
  END IF;
END
$$;

-- programs
ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS metadata JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'programs_tenant_id_facility_id_name_key'
      AND conrelid = 'public.programs'::regclass
  ) THEN
    ALTER TABLE public.programs
      ADD CONSTRAINT programs_tenant_id_facility_id_name_key
      UNIQUE (tenant_id, facility_id, name);
  END IF;
END
$$;

-- ══════════════════════════════════════════════
-- b) Missing indexes — all wrapped in DO blocks to guard against
--    columns that may be absent on this remote schema variant
-- ══════════════════════════════════════════════

-- visits: patient history lookup (very common — all patient chart queries)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='visits' AND column_name='deleted_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_visits_patient_date
      ON public.visits(patient_id, visit_date DESC)
      WHERE deleted_at IS NULL';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_visits_patient_date
      ON public.visits(patient_id, visit_date DESC)';
  END IF;
END$$;

-- payment_journals: unposted entries (day-end reconciliation)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='payment_journals') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_pj_unposted
      ON public.payment_journals(facility_id, entry_date DESC)
      WHERE posted_at IS NULL';
  ELSE
    RAISE NOTICE 'payment_journals table not found — skipping idx_pj_unposted.';
  END IF;
END$$;

-- diagnoses: ICD-10 code lookup for disease burden reporting
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='diagnoses' AND column_name='deleted_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_diagnoses_icd10
      ON public.diagnoses(icd10_code, tenant_id)
      WHERE icd10_code IS NOT NULL AND deleted_at IS NULL';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_diagnoses_icd10
      ON public.diagnoses(icd10_code, tenant_id)
      WHERE icd10_code IS NOT NULL';
  END IF;
END$$;

-- patient_conditions: SNOMED code lookups (table added in FIX 15)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='patient_conditions') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='patient_conditions' AND column_name='deleted_at') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_pc_snomed
        ON public.patient_conditions(snomed_code)
        WHERE snomed_code IS NOT NULL AND deleted_at IS NULL';
    ELSE
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_pc_snomed
        ON public.patient_conditions(snomed_code)
        WHERE snomed_code IS NOT NULL';
    END IF;
  ELSE
    RAISE NOTICE 'patient_conditions table not found — skipping idx_pc_snomed.';
  END IF;
END$$;

-- medication_orders: active orders per patient (DDI + allergy checks)
CREATE INDEX IF NOT EXISTS idx_mo_patient_active
  ON public.medication_orders(patient_id, status)
  WHERE status NOT IN ('discontinued', 'cancelled');

-- admissions: active inpatient list (very frequent query)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admissions' AND column_name='facility_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_admissions_active
      ON public.admissions(facility_id, status, admission_date DESC)
      WHERE status = ''active''';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_admissions_active
      ON public.admissions(status, admission_date DESC)
      WHERE status = ''active''';
  END IF;
END$$;

-- lab_orders: pending orders worklist
-- Note: lab_orders.facility_id may not exist on all schema variants (FIX_09 found it absent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='lab_orders' AND column_name='facility_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_lab_pending
      ON public.lab_orders(facility_id, status, created_at DESC)
      WHERE status IN (''pending'', ''collected'', ''processing'')';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_lab_pending
      ON public.lab_orders(status, created_at DESC)
      WHERE status IN (''pending'', ''collected'', ''processing'')';
  END IF;
END$$;

-- ══════════════════════════════════════════════
-- c) sex / gender field alignment
-- ══════════════════════════════════════════════
-- patients may have 'gender' (legacy, mixed-case: 'Male'/'Female'/'Other')
-- and 'sex' (W2, lowercase: 'male'/'female'/'other'/'unknown').
-- Back-fill sex from gender where sex is NULL.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='patients' AND column_name='sex')
  AND EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='patients' AND column_name='gender')
  THEN
    UPDATE public.patients
    SET sex = LOWER(gender)
    WHERE sex IS NULL AND gender IS NOT NULL;

    RAISE NOTICE 'Back-filled sex from gender.';
  END IF;
END
$$;

-- Add comment distinguishing the two fields
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='patients' AND column_name='sex') THEN
    COMMENT ON COLUMN public.patients.sex IS
      'Biological sex assigned at birth (FHIR AdministrativeSex): '
      'male | female | other | unknown. '
      'Authoritative source for clinical decisions (drug dosing, screening). '
      'Distinct from the ''gender'' column which captures gender identity.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='patients' AND column_name='gender') THEN
    COMMENT ON COLUMN public.patients.gender IS
      'Gender identity as reported by patient. '
      'Distinct from ''sex'' (biological sex at birth). '
      'Use ''sex'' for clinical decision logic.';
  END IF;
END
$$;

-- ══════════════════════════════════════════════
-- d) medication_dispense → stock_movements linkage
-- ══════════════════════════════════════════════
-- When a medication is dispensed, create a corresponding outflow
-- stock movement to keep inventory accurate.

ALTER TABLE public.medication_dispense
  ADD COLUMN IF NOT EXISTS stock_movement_id UUID
    REFERENCES public.stock_movements(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.medication_dispense.stock_movement_id IS
  'FK to stock_movements row created when this dispense was recorded. '
  'Ensures inventory is decremented on dispensing.';

CREATE OR REPLACE FUNCTION public.link_dispense_to_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item_id UUID;
  v_movement_id UUID;
BEGIN
  -- Only create movement on INSERT or when status transitions to 'dispensed'
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'dispensed' THEN
    RETURN NEW;
  END IF;
  -- Skip if already linked
  IF NEW.stock_movement_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Find inventory item matching medication name + facility
  SELECT id INTO v_item_id
  FROM public.inventory_items
  WHERE facility_id = NEW.facility_id
    AND (
      LOWER(item_name) LIKE '%' || LOWER(NEW.medication_name) || '%'
      OR LOWER(NEW.medication_name) LIKE '%' || LOWER(item_name) || '%'
    )
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_item_id IS NULL THEN
    -- No inventory item found — log and continue (non-blocking)
    RAISE WARNING 'No inventory item found for medication "%"; stock not decremented.', NEW.medication_name;
    RETURN NEW;
  END IF;

  -- Insert outflow stock movement
  INSERT INTO public.stock_movements (
    tenant_id, facility_id,
    item_id,
    movement_type,
    quantity,
    reference_type,
    reference_id,
    notes,
    created_by,
    created_at
  ) VALUES (
    NEW.tenant_id, NEW.facility_id,
    v_item_id,
    'issue',
    NEW.quantity_dispensed,
    'medication_dispense',
    NEW.id,
    'Auto-created from medication_dispense ' || NEW.id::TEXT,
    NEW.dispensed_by,
    NEW.dispensed_at
  )
  RETURNING id INTO v_movement_id;

  -- Link back
  NEW.stock_movement_id := v_movement_id;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'link_dispense_to_stock failed: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dispense_to_stock ON public.medication_dispense;

CREATE TRIGGER trg_dispense_to_stock
  BEFORE INSERT OR UPDATE OF status ON public.medication_dispense
  FOR EACH ROW
  EXECUTE FUNCTION public.link_dispense_to_stock();

-- ══════════════════════════════════════════════
-- e) Audit log immutability enforcement
-- ══════════════════════════════════════════════
-- Raise an exception on any attempt to UPDATE or DELETE an audit_log row.

CREATE OR REPLACE FUNCTION public.audit_log_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is immutable. DELETE/UPDATE of audit records is not permitted. '
    'SQLSTATE: P0003'
    USING ERRCODE = 'P0003';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON public.audit_log;

CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_log_immutable();

COMMENT ON FUNCTION public.audit_log_immutable() IS
  'Prevents UPDATE or DELETE on audit_log rows. '
  'Audit records are append-only for compliance.';

-- ══════════════════════════════════════════════
-- f) ICD-10 format validation on diagnoses
-- ══════════════════════════════════════════════
-- ICD-10 codes follow pattern: letter + 2 digits + optional decimal + 1-2 chars
-- e.g. A01.0, Z00, B20, J18.9
-- We add a non-blocking CHECK that warns on clearly wrong formats.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_diagnoses_icd10_format'
      AND conrelid = 'public.diagnoses'::regclass
  ) THEN
    ALTER TABLE public.diagnoses
      ADD CONSTRAINT chk_diagnoses_icd10_format
      CHECK (
        icd10_code IS NULL
        OR icd10_code ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{0,4})?$'
      );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not add ICD-10 format constraint: % %', SQLSTATE, SQLERRM;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  'visits patient_date index' AS check_name,
  COUNT(*) > 0 AS exists
FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'idx_visits_patient_date'
UNION ALL
SELECT
  'pj unposted index',
  COUNT(*) > 0
FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'idx_pj_unposted'
UNION ALL
SELECT
  'audit_log immutable trigger',
  COUNT(*) > 0
FROM pg_trigger
WHERE tgname = 'trg_audit_log_immutable'
  AND tgrelid = 'public.audit_log'::regclass
UNION ALL
SELECT
  'drug_interactions seeded',
  COUNT(*) > 0
FROM public.drug_interactions;
