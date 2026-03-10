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
