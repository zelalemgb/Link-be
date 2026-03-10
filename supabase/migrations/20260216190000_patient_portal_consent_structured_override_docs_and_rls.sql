-- Issue 16 / CONSENT-G06: Patient portal consent clinical-safety enforcement (structured override docs) + RLS hardening.
-- Goal:
-- - Ensure portal consent history is append-only and structurally captures warning-specific override documentation.
-- - Enforce: when high-risk warnings apply, override documentation is required (guardian/interpreter/low-comprehension remediation).
-- - Add RLS policies so patients can read their own portal consents + history in a tenant-safe way.

-- Helper functions used by patient-portal RLS (kept idempotent so this migration can be applied standalone).
CREATE OR REPLACE FUNCTION public.patient_portal_claim_text(p_claim_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::json ->> p_claim_key, '');
$$;

CREATE OR REPLACE FUNCTION public.current_patient_portal_account_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT pa.id
  FROM public.patient_accounts pa
  WHERE pa.tenant_id = (public.patient_portal_claim_text('tenant_id'))::uuid
    AND pa.phone_number = public.patient_portal_claim_text('phone')
  LIMIT 1;
$$;

-- 1) Append-only enforcement for portal consent history.
CREATE OR REPLACE FUNCTION public.prevent_patient_portal_consent_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'patient_portal_consent_history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS prevent_patient_portal_consent_history_update ON public.patient_portal_consent_history;
CREATE TRIGGER prevent_patient_portal_consent_history_update
  BEFORE UPDATE ON public.patient_portal_consent_history
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_patient_portal_consent_history_mutation();

DROP TRIGGER IF EXISTS prevent_patient_portal_consent_history_delete ON public.patient_portal_consent_history;
CREATE TRIGGER prevent_patient_portal_consent_history_delete
  BEFORE DELETE ON public.patient_portal_consent_history
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_patient_portal_consent_history_mutation();

-- 2) Structured clinical safety capture columns on history.
ALTER TABLE public.patient_portal_consent_history
  ADD COLUMN IF NOT EXISTS comprehension_text TEXT,
  ADD COLUMN IF NOT EXISTS comprehension_language TEXT,
  ADD COLUMN IF NOT EXISTS comprehension_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ui_language TEXT,
  ADD COLUMN IF NOT EXISTS warning_low_comprehension_length BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warning_language_mismatch BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS warning_patient_is_minor BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS high_risk_flag BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS high_risk_override BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason TEXT,
  ADD COLUMN IF NOT EXISTS override_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS override_guardian_name TEXT,
  ADD COLUMN IF NOT EXISTS override_guardian_relationship TEXT,
  ADD COLUMN IF NOT EXISTS override_guardian_phone TEXT,
  ADD COLUMN IF NOT EXISTS override_interpreter_used BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_interpreter_name TEXT,
  ADD COLUMN IF NOT EXISTS override_interpreter_language TEXT,
  ADD COLUMN IF NOT EXISTS override_language_support_notes TEXT,
  ADD COLUMN IF NOT EXISTS override_low_comprehension_remediation TEXT;

-- 3) Populate derived columns (warnings + override docs) from metadata and authoritative patient DOB.
-- Notes:
-- - This keeps existing API writes backward-compatible (metadata continues to be accepted),
--   while also making the safety-critical fields queryable and enforceable by constraints.
-- - We intentionally compute warning flags server-side, rather than trusting client-provided arrays.
CREATE OR REPLACE FUNCTION public.apply_patient_portal_consent_history_clinical_safety()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_dob date;
  v_age_years integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  NEW.created_at := COALESCE(NEW.created_at, v_now);

  IF NEW.action = 'grant' THEN
    NEW.comprehension_text := COALESCE(
      NEW.comprehension_text,
      NULLIF(btrim(NEW.metadata->>'comprehensionText'), '')
    );
    NEW.comprehension_language := COALESCE(
      NEW.comprehension_language,
      NULLIF(btrim(NEW.metadata->>'comprehensionLanguage'), '')
    );
    NEW.ui_language := COALESCE(
      NEW.ui_language,
      NULLIF(btrim(NEW.metadata->>'uiLanguage'), '')
    );

    BEGIN
      NEW.comprehension_recorded_at := COALESCE(
        NEW.comprehension_recorded_at,
        (NULLIF(NEW.metadata->>'comprehensionRecordedAt', ''))::timestamptz,
        NEW.created_at
      );
    EXCEPTION
      WHEN OTHERS THEN
        NEW.comprehension_recorded_at := COALESCE(NEW.comprehension_recorded_at, NEW.created_at);
    END;

    BEGIN
      NEW.high_risk_override := COALESCE(
        (NULLIF(NEW.metadata->>'highRiskOverride', ''))::boolean,
        NEW.high_risk_override,
        false -- defensive fallback
      );
    EXCEPTION
      WHEN OTHERS THEN
        NEW.high_risk_override := COALESCE(NEW.high_risk_override, false);
    END;

    NEW.override_reason := COALESCE(
      NEW.override_reason,
      NULLIF(btrim(NEW.metadata->>'overrideReason'), '')
    );
    NEW.override_at := COALESCE(NEW.override_at, NEW.created_at);

    -- Guardian documentation (required when patient_is_minor warning applies).
    NEW.override_guardian_name := COALESCE(
      NEW.override_guardian_name,
      NULLIF(btrim(NEW.metadata->>'guardianName'), '')
    );
    NEW.override_guardian_relationship := COALESCE(
      NEW.override_guardian_relationship,
      NULLIF(btrim(NEW.metadata->>'guardianRelationship'), '')
    );
    NEW.override_guardian_phone := COALESCE(
      NEW.override_guardian_phone,
      NULLIF(btrim(NEW.metadata->>'guardianPhone'), '')
    );

    -- Interpreter/language support documentation (required when language_mismatch warning applies).
    BEGIN
      NEW.override_interpreter_used := COALESCE(
        (NULLIF(NEW.metadata->>'interpreterUsed', ''))::boolean,
        NEW.override_interpreter_used,
        false -- defensive fallback
      );
    EXCEPTION
      WHEN OTHERS THEN
        NEW.override_interpreter_used := COALESCE(NEW.override_interpreter_used, false);
    END;

    NEW.override_interpreter_name := COALESCE(
      NEW.override_interpreter_name,
      NULLIF(btrim(NEW.metadata->>'interpreterName'), '')
    );
    NEW.override_interpreter_language := COALESCE(
      NEW.override_interpreter_language,
      NULLIF(btrim(NEW.metadata->>'interpreterLanguage'), '')
    );
    NEW.override_language_support_notes := COALESCE(
      NEW.override_language_support_notes,
      NULLIF(btrim(NEW.metadata->>'languageSupportNotes'), '')
    );

    -- Low-comprehension remediation documentation (required when low_comprehension_length warning applies).
    NEW.override_low_comprehension_remediation := COALESCE(
      NEW.override_low_comprehension_remediation,
      NULLIF(btrim(NEW.metadata->>'lowComprehensionRemediation'), '')
    );

    -- Warning flags (computed from stored fields).
    NEW.warning_low_comprehension_length := (
      NEW.comprehension_text IS NOT NULL
      AND length(btrim(NEW.comprehension_text)) < 80
    );

    NEW.warning_language_mismatch := (
      NEW.ui_language IS NOT NULL
      AND NEW.comprehension_language IS NOT NULL
      AND lower(NEW.ui_language) <> lower(NEW.comprehension_language)
    );

    NEW.warning_patient_is_minor := false;
    SELECT pa.date_of_birth
    INTO v_dob
    FROM public.patient_accounts pa
    WHERE pa.id = NEW.patient_account_id
      AND pa.tenant_id = NEW.tenant_id
    LIMIT 1;
    IF v_dob IS NOT NULL THEN
      v_age_years := date_part('year', age(current_date, v_dob))::int;
      IF v_age_years >= 0 AND v_age_years < 18 THEN
        NEW.warning_patient_is_minor := true;
      END IF;
    END IF;

    NEW.high_risk_flag := (
      NEW.warning_low_comprehension_length
      OR NEW.warning_language_mismatch
      OR NEW.warning_patient_is_minor
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apply_patient_portal_consent_history_clinical_safety
  ON public.patient_portal_consent_history;
CREATE TRIGGER apply_patient_portal_consent_history_clinical_safety
  BEFORE INSERT ON public.patient_portal_consent_history
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_patient_portal_consent_history_clinical_safety();

-- 4) Clinical safety constraints (NOT VALID to avoid legacy failures; enforced on new writes).
ALTER TABLE public.patient_portal_consent_history
  DROP CONSTRAINT IF EXISTS patient_portal_consent_history_grant_comprehension_required_chk;
ALTER TABLE public.patient_portal_consent_history
  ADD CONSTRAINT patient_portal_consent_history_grant_comprehension_required_chk CHECK (
    action <> 'grant'
    OR (
      comprehension_text IS NOT NULL
      AND length(btrim(comprehension_text)) >= 20
      AND comprehension_language IS NOT NULL
      AND length(btrim(comprehension_language)) >= 2
      AND comprehension_recorded_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.patient_portal_consent_history
  DROP CONSTRAINT IF EXISTS patient_portal_consent_history_high_risk_override_required_chk;
ALTER TABLE public.patient_portal_consent_history
  ADD CONSTRAINT patient_portal_consent_history_high_risk_override_required_chk CHECK (
    action <> 'grant'
    OR high_risk_flag = false
    OR (
      high_risk_override = true
      AND override_reason IS NOT NULL
      AND length(btrim(override_reason)) >= 10
      AND override_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.patient_portal_consent_history
  DROP CONSTRAINT IF EXISTS patient_portal_consent_history_minor_guardian_override_chk;
ALTER TABLE public.patient_portal_consent_history
  ADD CONSTRAINT patient_portal_consent_history_minor_guardian_override_chk CHECK (
    action <> 'grant'
    OR warning_patient_is_minor = false
    OR (
      override_guardian_name IS NOT NULL
      AND length(btrim(override_guardian_name)) >= 2
      AND override_guardian_relationship IS NOT NULL
      AND length(btrim(override_guardian_relationship)) >= 2
      AND override_guardian_phone IS NOT NULL
      AND length(btrim(override_guardian_phone)) >= 7
    )
  ) NOT VALID;

ALTER TABLE public.patient_portal_consent_history
  DROP CONSTRAINT IF EXISTS patient_portal_consent_history_language_mismatch_override_chk;
ALTER TABLE public.patient_portal_consent_history
  ADD CONSTRAINT patient_portal_consent_history_language_mismatch_override_chk CHECK (
    action <> 'grant'
    OR warning_language_mismatch = false
    OR (
      (
        override_interpreter_used = true
        AND override_interpreter_name IS NOT NULL
        AND length(btrim(override_interpreter_name)) >= 2
        AND override_interpreter_language IS NOT NULL
        AND length(btrim(override_interpreter_language)) >= 2
      )
      OR (
        override_interpreter_used = false
        AND override_language_support_notes IS NOT NULL
        AND length(btrim(override_language_support_notes)) >= 10
      )
    )
  ) NOT VALID;

ALTER TABLE public.patient_portal_consent_history
  DROP CONSTRAINT IF EXISTS patient_portal_consent_history_low_comprehension_override_chk;
ALTER TABLE public.patient_portal_consent_history
  ADD CONSTRAINT patient_portal_consent_history_low_comprehension_override_chk CHECK (
    action <> 'grant'
    OR warning_low_comprehension_length = false
    OR (
      override_low_comprehension_remediation IS NOT NULL
      AND length(btrim(override_low_comprehension_remediation)) >= 10
    )
  ) NOT VALID;

-- 5) RLS: patient-owned boundaries for portal consents and history.
ALTER TABLE public.patient_portal_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_portal_consent_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patients can view their own portal consents" ON public.patient_portal_consents;
CREATE POLICY "Patients can view their own portal consents" ON public.patient_portal_consents
  FOR SELECT TO authenticated
  USING (
    tenant_id = (public.patient_portal_claim_text('tenant_id'))::uuid
    AND patient_account_id = public.current_patient_portal_account_id()
  );

DROP POLICY IF EXISTS "Patients can view their own portal consent history" ON public.patient_portal_consent_history;
CREATE POLICY "Patients can view their own portal consent history" ON public.patient_portal_consent_history
  FOR SELECT TO authenticated
  USING (
    tenant_id = (public.patient_portal_claim_text('tenant_id'))::uuid
    AND patient_account_id = public.current_patient_portal_account_id()
  );
