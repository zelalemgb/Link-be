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
