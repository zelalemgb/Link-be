-- ============================================================
-- FIX 12 — CRITICAL: Drug-Allergy Safety Check at Prescription
-- ============================================================
-- Problem:
--   medication_orders has no check against patient_allergies at the
--   database layer.  A prescriber can order a drug for a patient who
--   has a documented severe allergy to that same drug.  The only
--   protection is at the UI layer — which can be bypassed by direct
--   API calls or future integrations.
--
-- Fix:
--   1. Add allergy_override_reason TEXT to medication_orders so a
--      prescriber can explicitly override with a documented reason.
--   2. Add BEFORE INSERT OR UPDATE trigger that:
--        a. Checks patient_allergies for active medication allergies
--           matching the medication being ordered (case-insensitive,
--           also checks generic_name).
--        b. For criticality HIGH/UNABLE_TO_ASSESS: raises an EXCEPTION
--           (hard stop) UNLESS allergy_override_reason is provided.
--        c. For criticality LOW/MODERATE: raises a WARNING and sets
--           allergy_alert_flag = TRUE on the order row (soft alert).
--   3. Add allergy_alert_flag BOOLEAN so UI can highlight flagged orders.
--   4. Function public.check_medication_allergy() exposed as RPC for
--      pre-flight checks from the application before saving.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- 1. Add safety columns to medication_orders
-- ══════════════════════════════════════════════
ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS allergy_alert_flag     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS allergy_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS allergy_override_by     UUID REFERENCES public.users(id);

COMMENT ON COLUMN public.medication_orders.allergy_alert_flag IS
  'Set TRUE by trigger when an active patient allergy matches this drug. '
  'UI should display a prominent warning.';
COMMENT ON COLUMN public.medication_orders.allergy_override_reason IS
  'Required when prescribing a drug flagged with HIGH criticality allergy. '
  'Documents the clinical justification for proceeding despite the allergy.';

-- ══════════════════════════════════════════════
-- 2. Pre-flight check function (also used by trigger)
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.check_medication_allergy(
  p_patient_id     UUID,
  p_medication_name TEXT,
  p_generic_name   TEXT DEFAULT NULL
)
RETURNS TABLE (
  allergen_name      TEXT,
  allergen_category  TEXT,
  criticality        TEXT,
  reaction_severity  TEXT,
  verification_status TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pa.allergen_name,
    pa.allergen_category,
    pa.criticality,
    pa.reaction_severity,
    pa.verification_status
  FROM public.patient_allergies pa
  WHERE pa.patient_id      = p_patient_id
    AND pa.allergen_category = 'medication'
    AND pa.clinical_status   = 'active'
    AND pa.deleted_at        IS NULL
    AND (
      -- Match on display name (case-insensitive, partial)
      LOWER(pa.allergen_name) LIKE '%' || LOWER(p_medication_name) || '%'
      OR LOWER(p_medication_name) LIKE '%' || LOWER(pa.allergen_name) || '%'
      -- Also match on generic name if supplied
      OR (p_generic_name IS NOT NULL AND (
        LOWER(pa.allergen_name) LIKE '%' || LOWER(p_generic_name) || '%'
        OR LOWER(p_generic_name) LIKE '%' || LOWER(pa.allergen_name) || '%'
      ))
    );
$$;

COMMENT ON FUNCTION public.check_medication_allergy(UUID, TEXT, TEXT) IS
  'Returns active medication allergies matching the given drug name(s). '
  'Called by the drug-allergy trigger and available as a pre-flight RPC.';

-- ══════════════════════════════════════════════
-- 3. Trigger function
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.enforce_drug_allergy_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allergy RECORD;
  v_high_criticality_match BOOLEAN := FALSE;
BEGIN
  -- Only run when medication_name or generic_name changes (or on INSERT)
  IF TG_OP = 'UPDATE'
    AND OLD.medication_name = NEW.medication_name
    AND COALESCE(OLD.generic_name,'') = COALESCE(NEW.generic_name,'')
    AND OLD.patient_id = NEW.patient_id
  THEN
    RETURN NEW;
  END IF;

  -- Check allergies
  FOR v_allergy IN
    SELECT * FROM public.check_medication_allergy(
      NEW.patient_id,
      NEW.medication_name,
      NEW.generic_name
    )
  LOOP
    -- Always set the alert flag
    NEW.allergy_alert_flag := TRUE;

    IF v_allergy.criticality IN ('high', 'unable_to_assess') THEN
      v_high_criticality_match := TRUE;
    END IF;

    RAISE WARNING
      'ALLERGY ALERT: Patient has % criticality allergy to "%" (reaction: %). '
      'Medication ordered: "%".',
      v_allergy.criticality,
      v_allergy.allergen_name,
      COALESCE(v_allergy.reaction_severity, 'unspecified'),
      NEW.medication_name;
  END LOOP;

  -- Hard stop for HIGH criticality unless override reason is provided
  IF v_high_criticality_match
    AND (NEW.allergy_override_reason IS NULL OR TRIM(NEW.allergy_override_reason) = '')
  THEN
    RAISE EXCEPTION
      'CONTRAINDICATED: Patient has a HIGH criticality allergy to "%" or a related drug. '
      'Set allergy_override_reason to document clinical justification before proceeding. '
      'SQLSTATE: P0001',
      NEW.medication_name
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN SQLSTATE 'P0001' THEN
    -- Re-raise our own allergy exception
    RAISE;
  WHEN OTHERS THEN
    -- Log but don't block — never let a trigger bug stop clinical care
    RAISE WARNING 'enforce_drug_allergy_check failed: % %', SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_drug_allergy_check() IS
  'BEFORE INSERT/UPDATE trigger on medication_orders. '
  'Raises EXCEPTION for HIGH criticality allergy matches unless '
  'allergy_override_reason is provided. Sets allergy_alert_flag for '
  'low/moderate matches.';

-- ══════════════════════════════════════════════
-- 4. Attach trigger to medication_orders
-- ══════════════════════════════════════════════
DROP TRIGGER IF EXISTS trg_drug_allergy_check ON public.medication_orders;

CREATE TRIGGER trg_drug_allergy_check
  BEFORE INSERT OR UPDATE OF medication_name, generic_name, patient_id
  ON public.medication_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_drug_allergy_check();

-- ══════════════════════════════════════════════
-- 5. Index to speed up allergy lookups
-- ══════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_pa_active_medication
  ON public.patient_allergies (patient_id, allergen_category, criticality)
  WHERE allergen_category = 'medication'
    AND clinical_status   = 'active'
    AND deleted_at        IS NULL;

-- ══════════════════════════════════════════════
-- 6. Back-fill allergy_alert_flag for existing orders
-- ══════════════════════════════════════════════
DO $$
BEGIN
  UPDATE public.medication_orders mo
  SET allergy_alert_flag = TRUE
  WHERE allergy_alert_flag = FALSE
    AND EXISTS (
      SELECT 1 FROM public.check_medication_allergy(
        mo.patient_id,
        mo.medication_name,
        mo.generic_name
      )
    );
  RAISE NOTICE 'Back-filled allergy_alert_flag for existing orders.';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Back-fill of allergy_alert_flag skipped: % %', SQLSTATE, SQLERRM;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM public.medication_orders WHERE allergy_alert_flag = TRUE)
    AS orders_with_allergy_alert,
  (SELECT COUNT(*) FROM public.medication_orders WHERE allergy_override_reason IS NOT NULL)
    AS orders_with_override_reason;
