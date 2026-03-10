-- Issue 16 (Release Scope): Consent clinical-safety fields + constraints + indexes.
-- Goal: enforceable at data layer, revoke-immediate, test-covered.

-- 1) Extend consent schema for clinical safety gates.
ALTER TABLE public.patient_data_consents
  ADD COLUMN IF NOT EXISTS comprehension_text TEXT,
  ADD COLUMN IF NOT EXISTS comprehension_language TEXT,
  ADD COLUMN IF NOT EXISTS comprehension_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoke_acknowledged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS revoked_by_user_id UUID,
  ADD COLUMN IF NOT EXISTS high_risk_flag BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason TEXT,
  ADD COLUMN IF NOT EXISTS override_actor_user_id UUID,
  ADD COLUMN IF NOT EXISTS override_actor_auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS override_at TIMESTAMPTZ;

ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_revoked_by_user_fkey;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_revoked_by_user_fkey
  FOREIGN KEY (revoked_by_user_id)
  REFERENCES public.users(id)
  ON DELETE SET NULL;

ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_override_actor_user_fkey;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_override_actor_user_fkey
  FOREIGN KEY (override_actor_user_id)
  REFERENCES public.users(id)
  ON DELETE SET NULL;

-- 2) Clinical safety gate constraints (NOT VALID to avoid legacy failures; enforced on new writes).
ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_comprehension_required_chk;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_comprehension_required_chk CHECK (
    status <> 'granted'
    OR (
      comprehension_text IS NOT NULL
      AND length(btrim(comprehension_text)) >= 20
      AND comprehension_language IS NOT NULL
      AND length(btrim(comprehension_language)) >= 2
      AND comprehension_recorded_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_revocation_ack_chk;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_revocation_ack_chk CHECK (
    (status = 'granted' AND revoke_acknowledged = false)
    OR (
      status = 'revoked'
      AND revoke_acknowledged = true
      AND revoked_reason IS NOT NULL
      AND length(btrim(revoked_reason)) >= 3
      AND revoked_at IS NOT NULL
      AND (
        revoked_by_auth_user_id IS NOT NULL
        OR revoked_by_user_id IS NOT NULL
      )
    )
  ) NOT VALID;

ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_high_risk_override_chk;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_high_risk_override_chk CHECK (
    high_risk_flag = false
    OR (
      high_risk_flag = true
      AND override_reason IS NOT NULL
      AND length(btrim(override_reason)) >= 6
      AND override_at IS NOT NULL
      AND (
        override_actor_user_id IS NOT NULL
        OR override_actor_auth_user_id IS NOT NULL
      )
    )
  ) NOT VALID;

-- Keep recorded_at aligned for granted consents when omitted.
CREATE OR REPLACE FUNCTION public.apply_patient_data_consent_status_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'granted' THEN
      NEW.granted_at := COALESCE(NEW.granted_at, now());
      NEW.comprehension_recorded_at := COALESCE(NEW.comprehension_recorded_at, NEW.granted_at, now());
      NEW.revoked_at := NULL;
      NEW.revoked_reason := NULL;
      NEW.revoked_by_auth_user_id := NULL;
      NEW.revoked_by_user_id := NULL;
      NEW.revoke_acknowledged := COALESCE(NEW.revoke_acknowledged, false);
    ELSIF NEW.status = 'revoked' THEN
      NEW.revoked_at := COALESCE(NEW.revoked_at, now());
    END IF;
  ELSE
    IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
      NEW.revoked_at := COALESCE(NEW.revoked_at, now());
    ELSIF NEW.status = 'granted' AND OLD.status IS DISTINCT FROM 'granted' THEN
      NEW.granted_at := now();
      NEW.comprehension_recorded_at := COALESCE(NEW.comprehension_recorded_at, NEW.granted_at, now());
      NEW.revoked_at := NULL;
      NEW.revoked_reason := NULL;
      NEW.revoked_by_auth_user_id := NULL;
      NEW.revoked_by_user_id := NULL;
      NEW.revoke_acknowledged := false;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Make revoke helper set explicit acknowledgment by default.
CREATE OR REPLACE FUNCTION public.revoke_patient_data_consent(
  p_consent_id uuid,
  p_revoked_reason text DEFAULT NULL,
  p_revoked_by_auth_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.patient_data_consents
  SET
    status = 'revoked',
    revoke_acknowledged = true,
    revoked_reason = p_revoked_reason,
    revoked_by_auth_user_id = p_revoked_by_auth_user_id
  WHERE id = p_consent_id
    AND status = 'granted';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- 3) Indexes for active lookup and history queryability.
CREATE INDEX IF NOT EXISTS idx_patient_data_consents_active_patient_scope
  ON public.patient_data_consents (tenant_id, patient_account_id, grantee_scope)
  WHERE status = 'granted';

CREATE INDEX IF NOT EXISTS idx_patient_data_consent_history_patient_created_at
  ON public.patient_data_consent_history (tenant_id, patient_account_id, created_at DESC);

-- 4) RLS refinements for safety clarity (constraints still enforce hard requirements).
DROP POLICY IF EXISTS "Patients can revoke their own consents" ON public.patient_data_consents;
CREATE POLICY "Patients can revoke their own consents" ON public.patient_data_consents
  FOR UPDATE TO authenticated
  USING (
    tenant_id = (public.patient_portal_claim_text('tenant_id'))::uuid
    AND patient_account_id = public.current_patient_portal_account_id()
  )
  WITH CHECK (
    tenant_id = (public.patient_portal_claim_text('tenant_id'))::uuid
    AND patient_account_id = public.current_patient_portal_account_id()
    AND (
      status = 'granted'
      OR (
        status = 'revoked'
        AND revoke_acknowledged = true
        AND revoked_reason IS NOT NULL
        AND length(btrim(revoked_reason)) >= 3
      )
    )
  );

-- Ensure history trigger captures new fields for auditability.
CREATE OR REPLACE FUNCTION public.log_patient_data_consent_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_common_metadata jsonb;
BEGIN
  v_common_metadata := jsonb_build_object(
    'status', NEW.status,
    'comprehension_language', NEW.comprehension_language,
    'comprehension_recorded_at', NEW.comprehension_recorded_at,
    'high_risk_flag', NEW.high_risk_flag,
    'override_reason', NEW.override_reason,
    'override_at', NEW.override_at,
    'revoke_acknowledged', NEW.revoke_acknowledged
  );

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.patient_data_consent_history (
      consent_id,
      tenant_id,
      patient_account_id,
      action,
      action_at,
      action_by_auth_user_id,
      grantee_scope,
      facility_id,
      provider_user_id,
      note,
      metadata
    )
    VALUES (
      NEW.id,
      NEW.tenant_id,
      NEW.patient_account_id,
      'granted',
      COALESCE(NEW.granted_at, now()),
      NEW.granted_by_auth_user_id,
      NEW.grantee_scope,
      NEW.facility_id,
      NEW.provider_user_id,
      NULL,
      v_common_metadata || jsonb_build_object('event', 'insert')
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.patient_data_consent_history (
      consent_id,
      tenant_id,
      patient_account_id,
      action,
      action_at,
      action_by_auth_user_id,
      grantee_scope,
      facility_id,
      provider_user_id,
      note,
      metadata
    )
    VALUES (
      NEW.id,
      NEW.tenant_id,
      NEW.patient_account_id,
      CASE WHEN NEW.status = 'revoked' THEN 'revoked' ELSE 'granted' END,
      CASE
        WHEN NEW.status = 'revoked' THEN COALESCE(NEW.revoked_at, now())
        ELSE COALESCE(NEW.granted_at, now())
      END,
      CASE
        WHEN NEW.status = 'revoked' THEN NEW.revoked_by_auth_user_id
        ELSE NEW.granted_by_auth_user_id
      END,
      NEW.grantee_scope,
      NEW.facility_id,
      NEW.provider_user_id,
      NEW.revoked_reason,
      v_common_metadata || jsonb_build_object('previous_status', OLD.status, 'new_status', NEW.status)
    );
  END IF;

  RETURN NEW;
END;
$$;
