-- ============================================================================
-- APPLY THIS: Issue 16 Consent schema + clinical safety enforcement
-- Project: qxihedrgltophafkuasa
-- Generated: 2026-02-17
-- Includes:
-- - 20260215120000_patient_consent_management_and_rls.sql
-- - 20260215131500_patient_portal_consents.sql
-- - 20260215133000_consent_clinical_safety_fields_and_indexes.sql
-- - 20260216190000_patient_portal_consent_structured_override_docs_and_rls.sql
-- ============================================================================

-- --------------------------------------------------------------------------
-- BEGIN 20260215120000_patient_consent_management_and_rls.sql
-- --------------------------------------------------------------------------
-- Issue 16: Patient portal consent management workflow (grant/revoke/history)
-- Adds tenant-safe consent schema and RLS enforcement for provider/facility scoped access.

-- Ensure composite uniqueness required for tenant-safe foreign keys.
ALTER TABLE public.patient_accounts
  DROP CONSTRAINT IF EXISTS patient_accounts_id_tenant_unique;
ALTER TABLE public.patient_accounts
  ADD CONSTRAINT patient_accounts_id_tenant_unique UNIQUE (id, tenant_id);

ALTER TABLE public.facilities
  DROP CONSTRAINT IF EXISTS facilities_id_tenant_unique;
ALTER TABLE public.facilities
  ADD CONSTRAINT facilities_id_tenant_unique UNIQUE (id, tenant_id);

CREATE TABLE IF NOT EXISTS public.patient_data_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_account_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  grantee_scope TEXT NOT NULL CHECK (grantee_scope IN ('facility', 'provider')),
  facility_id UUID,
  provider_user_id UUID,
  status TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by_auth_user_id UUID,
  revoked_at TIMESTAMPTZ,
  revoked_by_auth_user_id UUID,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patient_data_consents_scope_target_chk CHECK (
    (grantee_scope = 'facility' AND facility_id IS NOT NULL AND provider_user_id IS NULL)
    OR (grantee_scope = 'provider' AND provider_user_id IS NOT NULL)
  ),
  CONSTRAINT patient_data_consents_status_timestamps_chk CHECK (
    (status = 'granted' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_patient_account_tenant_fkey;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_patient_account_tenant_fkey
  FOREIGN KEY (patient_account_id, tenant_id)
  REFERENCES public.patient_accounts(id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_facility_tenant_fkey;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_facility_tenant_fkey
  FOREIGN KEY (facility_id, tenant_id)
  REFERENCES public.facilities(id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_provider_user_fkey;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_provider_user_fkey
  FOREIGN KEY (provider_user_id)
  REFERENCES public.users(id)
  ON DELETE CASCADE;

ALTER TABLE public.patient_data_consents
  DROP CONSTRAINT IF EXISTS patient_data_consents_id_tenant_unique;
ALTER TABLE public.patient_data_consents
  ADD CONSTRAINT patient_data_consents_id_tenant_unique UNIQUE (id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_patient_data_consents_patient_status
  ON public.patient_data_consents (tenant_id, patient_account_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_data_consents_active_facility_unique
  ON public.patient_data_consents (tenant_id, patient_account_id, facility_id)
  WHERE grantee_scope = 'facility' AND status = 'granted';

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_data_consents_active_provider_unique
  ON public.patient_data_consents (tenant_id, patient_account_id, provider_user_id)
  WHERE grantee_scope = 'provider' AND status = 'granted';

CREATE INDEX IF NOT EXISTS idx_patient_data_consents_active_provider_lookup
  ON public.patient_data_consents (tenant_id, provider_user_id, patient_account_id)
  WHERE grantee_scope = 'provider' AND status = 'granted';

CREATE INDEX IF NOT EXISTS idx_patient_data_consents_active_facility_lookup
  ON public.patient_data_consents (tenant_id, facility_id, patient_account_id)
  WHERE grantee_scope = 'facility' AND status = 'granted';

CREATE TABLE IF NOT EXISTS public.patient_data_consent_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  patient_account_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
  action_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action_by_auth_user_id UUID,
  grantee_scope TEXT NOT NULL CHECK (grantee_scope IN ('facility', 'provider')),
  facility_id UUID,
  provider_user_id UUID,
  note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.patient_data_consent_history
  DROP CONSTRAINT IF EXISTS patient_data_consent_history_consent_tenant_fkey;
ALTER TABLE public.patient_data_consent_history
  ADD CONSTRAINT patient_data_consent_history_consent_tenant_fkey
  FOREIGN KEY (consent_id, tenant_id)
  REFERENCES public.patient_data_consents(id, tenant_id)
  ON DELETE CASCADE;

ALTER TABLE public.patient_data_consent_history
  DROP CONSTRAINT IF EXISTS patient_data_consent_history_patient_account_tenant_fkey;
ALTER TABLE public.patient_data_consent_history
  ADD CONSTRAINT patient_data_consent_history_patient_account_tenant_fkey
  FOREIGN KEY (patient_account_id, tenant_id)
  REFERENCES public.patient_accounts(id, tenant_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_patient_data_consent_history_consent_action_at
  ON public.patient_data_consent_history (consent_id, action_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_data_consent_history_patient_action_at
  ON public.patient_data_consent_history (tenant_id, patient_account_id, action_at DESC);

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

CREATE OR REPLACE FUNCTION public.current_user_profile_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT u.id
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_user_facility_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT u.facility_id
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.current_user_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT u.tenant_id
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.enforce_patient_data_consent_targets()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_provider_tenant_id uuid;
  v_provider_facility_id uuid;
BEGIN
  IF NEW.grantee_scope = 'facility' THEN
    IF NEW.facility_id IS NULL OR NEW.provider_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'facility scope requires facility_id and no provider_user_id';
    END IF;
  ELSIF NEW.grantee_scope = 'provider' THEN
    IF NEW.provider_user_id IS NULL THEN
      RAISE EXCEPTION 'provider scope requires provider_user_id';
    END IF;

    SELECT u.tenant_id, u.facility_id
    INTO v_provider_tenant_id, v_provider_facility_id
    FROM public.users u
    WHERE u.id = NEW.provider_user_id;

    IF v_provider_tenant_id IS NULL THEN
      RAISE EXCEPTION 'provider_user_id does not resolve to a user profile';
    END IF;

    IF v_provider_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'provider_user_id tenant mismatch with consent tenant';
    END IF;

    IF NEW.facility_id IS NOT NULL AND v_provider_facility_id IS DISTINCT FROM NEW.facility_id THEN
      RAISE EXCEPTION 'provider_user_id facility mismatch with consent facility';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported grantee_scope %', NEW.grantee_scope;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_patient_data_consent_status_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'granted' THEN
      NEW.granted_at := COALESCE(NEW.granted_at, now());
      NEW.revoked_at := NULL;
      NEW.revoked_reason := NULL;
      NEW.revoked_by_auth_user_id := NULL;
    ELSIF NEW.status = 'revoked' THEN
      NEW.revoked_at := COALESCE(NEW.revoked_at, now());
    END IF;
  ELSE
    IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
      NEW.revoked_at := COALESCE(NEW.revoked_at, now());
    ELSIF NEW.status = 'granted' AND OLD.status IS DISTINCT FROM 'granted' THEN
      NEW.granted_at := now();
      NEW.revoked_at := NULL;
      NEW.revoked_reason := NULL;
      NEW.revoked_by_auth_user_id := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_patient_data_consent_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
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
      jsonb_build_object('status', NEW.status)
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
      jsonb_build_object('previous_status', OLD.status, 'new_status', NEW.status)
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_patient_data_consent_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'patient_data_consent_history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS enforce_patient_data_consent_targets ON public.patient_data_consents;
CREATE TRIGGER enforce_patient_data_consent_targets
  BEFORE INSERT OR UPDATE ON public.patient_data_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_patient_data_consent_targets();

DROP TRIGGER IF EXISTS apply_patient_data_consent_status_defaults ON public.patient_data_consents;
CREATE TRIGGER apply_patient_data_consent_status_defaults
  BEFORE INSERT OR UPDATE ON public.patient_data_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_patient_data_consent_status_defaults();

DROP TRIGGER IF EXISTS update_patient_data_consents_updated_at ON public.patient_data_consents;
CREATE TRIGGER update_patient_data_consents_updated_at
  BEFORE UPDATE ON public.patient_data_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS log_patient_data_consent_history ON public.patient_data_consents;
CREATE TRIGGER log_patient_data_consent_history
  AFTER INSERT OR UPDATE ON public.patient_data_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.log_patient_data_consent_history();

DROP TRIGGER IF EXISTS prevent_patient_data_consent_history_update ON public.patient_data_consent_history;
CREATE TRIGGER prevent_patient_data_consent_history_update
  BEFORE UPDATE ON public.patient_data_consent_history
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_patient_data_consent_history_mutation();

DROP TRIGGER IF EXISTS prevent_patient_data_consent_history_delete ON public.patient_data_consent_history;
CREATE TRIGGER prevent_patient_data_consent_history_delete
  BEFORE DELETE ON public.patient_data_consent_history
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_patient_data_consent_history_mutation();

CREATE OR REPLACE FUNCTION public.has_active_patient_data_consent(p_tenant_id uuid, p_patient_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.patient_data_consents c
    WHERE c.tenant_id = p_tenant_id
      AND c.patient_account_id = p_patient_account_id
      AND c.status = 'granted'
      AND (
        (c.grantee_scope = 'provider' AND c.provider_user_id = public.current_user_profile_id())
        OR
        (c.grantee_scope = 'facility' AND c.facility_id = public.current_user_facility_id())
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.grant_patient_data_consent(
  p_patient_account_id uuid,
  p_tenant_id uuid,
  p_grantee_scope text,
  p_facility_id uuid DEFAULT NULL,
  p_provider_user_id uuid DEFAULT NULL,
  p_granted_by_auth_user_id uuid DEFAULT auth.uid()
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.patient_data_consents (
    patient_account_id,
    tenant_id,
    grantee_scope,
    facility_id,
    provider_user_id,
    status,
    granted_by_auth_user_id,
    revoked_at,
    revoked_reason,
    revoked_by_auth_user_id
  )
  VALUES (
    p_patient_account_id,
    p_tenant_id,
    p_grantee_scope,
    p_facility_id,
    p_provider_user_id,
    'granted',
    p_granted_by_auth_user_id,
    NULL,
    NULL,
    NULL
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

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
    revoked_reason = p_revoked_reason,
    revoked_by_auth_user_id = p_revoked_by_auth_user_id
  WHERE id = p_consent_id
    AND status = 'granted';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

ALTER TABLE public.patient_data_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_data_consent_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patients can view their own consents" ON public.patient_data_consents;
CREATE POLICY "Patients can view their own consents" ON public.patient_data_consents
  FOR SELECT TO authenticated
  USING (
    tenant_id = (public.patient_portal_claim_text('tenant_id'))::uuid
    AND patient_account_id = public.current_patient_portal_account_id()
  );

DROP POLICY IF EXISTS "Patients can grant their own consents" ON public.patient_data_consents;
CREATE POLICY "Patients can grant their own consents" ON public.patient_data_consents
  FOR INSERT TO authenticated
  WITH CHECK (
    status = 'granted'
    AND tenant_id = (public.patient_portal_claim_text('tenant_id'))::uuid
    AND patient_account_id = public.current_patient_portal_account_id()
  );

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
    AND status IN ('granted', 'revoked')
  );

DROP POLICY IF EXISTS "Providers and facility staff can view granted consents" ON public.patient_data_consents;
CREATE POLICY "Providers and facility staff can view granted consents" ON public.patient_data_consents
  FOR SELECT TO authenticated
  USING (
    status = 'granted'
    AND tenant_id = public.current_user_tenant_id()
    AND (
      (grantee_scope = 'provider' AND provider_user_id = public.current_user_profile_id())
      OR (grantee_scope = 'facility' AND facility_id = public.current_user_facility_id())
    )
  );

DROP POLICY IF EXISTS "Patients can view their own consent history" ON public.patient_data_consent_history;
CREATE POLICY "Patients can view their own consent history" ON public.patient_data_consent_history
  FOR SELECT TO authenticated
  USING (
    tenant_id = (public.patient_portal_claim_text('tenant_id'))::uuid
    AND patient_account_id = public.current_patient_portal_account_id()
  );

DROP POLICY IF EXISTS "Tenant admins can view consent history" ON public.patient_data_consent_history;
CREATE POLICY "Tenant admins can view consent history" ON public.patient_data_consent_history
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.current_user_tenant_id()
    AND EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin', 'super_admin')
    )
  );

-- Consent-gated provider/facility access to patient-owned data.
DROP POLICY IF EXISTS "Consented providers can view patient documents" ON public.patient_documents;
CREATE POLICY "Consented providers can view patient documents" ON public.patient_documents
  FOR SELECT TO authenticated
  USING (public.has_active_patient_data_consent(tenant_id, patient_account_id));

DROP POLICY IF EXISTS "Consented providers can view visit summaries" ON public.patient_visit_summaries;
CREATE POLICY "Consented providers can view visit summaries" ON public.patient_visit_summaries
  FOR SELECT TO authenticated
  USING (public.has_active_patient_data_consent(tenant_id, patient_account_id));

DROP POLICY IF EXISTS "Consented providers can view symptom logs" ON public.patient_symptom_logs;
CREATE POLICY "Consented providers can view symptom logs" ON public.patient_symptom_logs
  FOR SELECT TO authenticated
  USING (public.has_active_patient_data_consent(tenant_id, patient_account_id));

COMMENT ON TABLE public.patient_data_consents IS
  'Patient-managed data-sharing consents scoped to provider/facility with grant/revoke lifecycle.';

COMMENT ON TABLE public.patient_data_consent_history IS
  'Immutable append-only history for patient consent grants/revocations.';

-- --------------------------------------------------------------------------
-- END 20260215120000_patient_consent_management_and_rls.sql
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- BEGIN 20260215131500_patient_portal_consents.sql
-- --------------------------------------------------------------------------
-- Issue 16: patient portal consent workflow storage.
-- Provides current-state + immutable history for grant/revoke actions.

CREATE TABLE IF NOT EXISTS public.patient_portal_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_account_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  consent_type TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  purpose TEXT,
  metadata JSONB,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patient_portal_consents_unique_scope UNIQUE (patient_account_id, tenant_id, facility_id, consent_type),
  CONSTRAINT patient_portal_consents_state_chk CHECK (
    (is_active = true AND revoked_at IS NULL)
    OR (is_active = false AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT patient_portal_consents_account_tenant_fkey
    FOREIGN KEY (patient_account_id, tenant_id)
    REFERENCES public.patient_accounts(id, tenant_id)
    ON DELETE CASCADE,
  CONSTRAINT patient_portal_consents_facility_tenant_fkey
    FOREIGN KEY (facility_id, tenant_id)
    REFERENCES public.facilities(id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_patient_portal_consents_tenant_account
  ON public.patient_portal_consents(tenant_id, patient_account_id);
CREATE INDEX IF NOT EXISTS idx_patient_portal_consents_tenant_facility
  ON public.patient_portal_consents(tenant_id, facility_id);
CREATE INDEX IF NOT EXISTS idx_patient_portal_consents_active
  ON public.patient_portal_consents(tenant_id, patient_account_id, is_active);

DROP TRIGGER IF EXISTS update_patient_portal_consents_updated_at
  ON public.patient_portal_consents;
CREATE TRIGGER update_patient_portal_consents_updated_at
  BEFORE UPDATE ON public.patient_portal_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.patient_portal_consent_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id UUID NOT NULL REFERENCES public.patient_portal_consents(id) ON DELETE CASCADE,
  patient_account_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  consent_type TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  metadata JSONB,
  actor_role TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patient_portal_consent_history_action_chk
    CHECK (action IN ('grant', 'revoke')),
  CONSTRAINT patient_portal_consent_history_account_tenant_fkey
    FOREIGN KEY (patient_account_id, tenant_id)
    REFERENCES public.patient_accounts(id, tenant_id)
    ON DELETE CASCADE,
  CONSTRAINT patient_portal_consent_history_facility_tenant_fkey
    FOREIGN KEY (facility_id, tenant_id)
    REFERENCES public.facilities(id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_patient_portal_consent_history_tenant_account_created
  ON public.patient_portal_consent_history(tenant_id, patient_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_patient_portal_consent_history_request_id
  ON public.patient_portal_consent_history(request_id)
  WHERE request_id IS NOT NULL;

COMMENT ON TABLE public.patient_portal_consents IS
  'Current consent state for patient portal data-sharing scopes.';
COMMENT ON TABLE public.patient_portal_consent_history IS
  'Append-only audit history for patient portal consent grant/revoke decisions.';

-- --------------------------------------------------------------------------
-- END 20260215131500_patient_portal_consents.sql
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- BEGIN 20260215133000_consent_clinical_safety_fields_and_indexes.sql
-- --------------------------------------------------------------------------
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

-- --------------------------------------------------------------------------
-- END 20260215133000_consent_clinical_safety_fields_and_indexes.sql
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- BEGIN 20260216190000_patient_portal_consent_structured_override_docs_and_rls.sql
-- --------------------------------------------------------------------------
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

-- --------------------------------------------------------------------------
-- END 20260216190000_patient_portal_consent_structured_override_docs_and_rls.sql
-- --------------------------------------------------------------------------

