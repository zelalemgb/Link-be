-- Canonical patient portal security hardening migration.
-- Includes tenant/consent constraints and stricter policy checks (Issue 20).

-- Track verified patient phone numbers per tenant.
CREATE TABLE IF NOT EXISTS public.patient_portal_phone_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  phone_number TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_number)
);

COMMENT ON TABLE public.patient_portal_phone_verifications IS
  'Tracks OTP verification status for patient portal phone numbers per tenant.';

CREATE INDEX IF NOT EXISTS idx_patient_portal_phone_verifications_tenant
  ON public.patient_portal_phone_verifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_portal_phone_verifications_tenant_phone
  ON public.patient_portal_phone_verifications(tenant_id, phone_number);

DROP TRIGGER IF EXISTS update_patient_portal_phone_verifications_updated_at
  ON public.patient_portal_phone_verifications;
CREATE TRIGGER update_patient_portal_phone_verifications_updated_at
  BEFORE UPDATE ON public.patient_portal_phone_verifications
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Consent/verification consistency: verified rows must carry verified_at.
UPDATE public.patient_portal_phone_verifications
SET verified_at = COALESCE(verified_at, created_at, now())
WHERE is_verified = true
  AND verified_at IS NULL;

UPDATE public.patient_portal_phone_verifications
SET verified_at = NULL
WHERE is_verified = false
  AND verified_at IS NOT NULL;

ALTER TABLE public.patient_portal_phone_verifications
  DROP CONSTRAINT IF EXISTS patient_portal_phone_verifications_verified_state_chk;
ALTER TABLE public.patient_portal_phone_verifications
  ADD CONSTRAINT patient_portal_phone_verifications_verified_state_chk CHECK (
    (is_verified = true AND verified_at IS NOT NULL)
    OR (is_verified = false AND verified_at IS NULL)
  );

-- Normalize tenant IDs from authoritative parents before enforcing cross-table constraints.
UPDATE public.patient_documents d
SET tenant_id = a.tenant_id
FROM public.patient_accounts a
WHERE d.patient_account_id = a.id
  AND d.tenant_id IS DISTINCT FROM a.tenant_id;

UPDATE public.patient_visit_summaries s
SET tenant_id = a.tenant_id
FROM public.patient_accounts a
WHERE s.patient_account_id = a.id
  AND s.tenant_id IS DISTINCT FROM a.tenant_id;

UPDATE public.patient_symptom_logs l
SET tenant_id = a.tenant_id
FROM public.patient_accounts a
WHERE l.patient_account_id = a.id
  AND l.tenant_id IS DISTINCT FROM a.tenant_id;

UPDATE public.patient_appointment_requests r
SET tenant_id = a.tenant_id
FROM public.patient_accounts a
WHERE r.patient_account_id = a.id
  AND r.tenant_id IS DISTINCT FROM a.tenant_id;

-- Tenant consistency constraints for child tables (NOT VALID to avoid long blocking validation).
ALTER TABLE public.patient_accounts
  DROP CONSTRAINT IF EXISTS patient_accounts_id_tenant_unique;
ALTER TABLE public.patient_accounts
  ADD CONSTRAINT patient_accounts_id_tenant_unique UNIQUE (id, tenant_id);

ALTER TABLE public.facilities
  DROP CONSTRAINT IF EXISTS facilities_id_tenant_unique;
ALTER TABLE public.facilities
  ADD CONSTRAINT facilities_id_tenant_unique UNIQUE (id, tenant_id);

ALTER TABLE public.patient_documents
  DROP CONSTRAINT IF EXISTS patient_documents_account_tenant_fkey;
ALTER TABLE public.patient_documents
  ADD CONSTRAINT patient_documents_account_tenant_fkey
  FOREIGN KEY (patient_account_id, tenant_id)
  REFERENCES public.patient_accounts(id, tenant_id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.patient_visit_summaries
  DROP CONSTRAINT IF EXISTS patient_visit_summaries_account_tenant_fkey;
ALTER TABLE public.patient_visit_summaries
  ADD CONSTRAINT patient_visit_summaries_account_tenant_fkey
  FOREIGN KEY (patient_account_id, tenant_id)
  REFERENCES public.patient_accounts(id, tenant_id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.patient_symptom_logs
  DROP CONSTRAINT IF EXISTS patient_symptom_logs_account_tenant_fkey;
ALTER TABLE public.patient_symptom_logs
  ADD CONSTRAINT patient_symptom_logs_account_tenant_fkey
  FOREIGN KEY (patient_account_id, tenant_id)
  REFERENCES public.patient_accounts(id, tenant_id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.patient_appointment_requests
  DROP CONSTRAINT IF EXISTS patient_appointment_requests_account_tenant_fkey;
ALTER TABLE public.patient_appointment_requests
  ADD CONSTRAINT patient_appointment_requests_account_tenant_fkey
  FOREIGN KEY (patient_account_id, tenant_id)
  REFERENCES public.patient_accounts(id, tenant_id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.patient_appointment_requests
  DROP CONSTRAINT IF EXISTS patient_appointment_requests_facility_tenant_fkey;
ALTER TABLE public.patient_appointment_requests
  ADD CONSTRAINT patient_appointment_requests_facility_tenant_fkey
  FOREIGN KEY (facility_id, tenant_id)
  REFERENCES public.facilities(id, tenant_id)
  ON DELETE RESTRICT
  NOT VALID;

-- Refresh patient portal policies with explicit WITH CHECK predicates.
ALTER TABLE public.patient_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_visit_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_symptom_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_appointment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patients can view their own account" ON public.patient_accounts;
CREATE POLICY "Patients can view their own account" ON public.patient_accounts
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
  );

DROP POLICY IF EXISTS "Patients can update their own account" ON public.patient_accounts;
CREATE POLICY "Patients can update their own account" ON public.patient_accounts
  FOR UPDATE USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
  )
  WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
  );

DROP POLICY IF EXISTS "Anyone can create patient account" ON public.patient_accounts;
DROP POLICY IF EXISTS "Verified patients can create account" ON public.patient_accounts;
CREATE POLICY "Verified patients can create account" ON public.patient_accounts
  FOR INSERT WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    AND EXISTS (
      SELECT 1
      FROM public.patient_portal_phone_verifications v
      WHERE v.tenant_id = public.patient_accounts.tenant_id
        AND v.phone_number = public.patient_accounts.phone_number
        AND v.is_verified = true
    )
  );

DROP POLICY IF EXISTS "Patients can view their own documents" ON public.patient_documents;
CREATE POLICY "Patients can view their own documents" ON public.patient_documents
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  );

DROP POLICY IF EXISTS "Patients can create their own documents" ON public.patient_documents;
CREATE POLICY "Patients can create their own documents" ON public.patient_documents
  FOR INSERT WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  );

DROP POLICY IF EXISTS "Patients can update their own documents" ON public.patient_documents;
CREATE POLICY "Patients can update their own documents" ON public.patient_documents
  FOR UPDATE USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  )
  WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  );

DROP POLICY IF EXISTS "Patients can delete their own documents" ON public.patient_documents;
CREATE POLICY "Patients can delete their own documents" ON public.patient_documents
  FOR DELETE USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  );

DROP POLICY IF EXISTS "Patients can view their own visit summaries" ON public.patient_visit_summaries;
CREATE POLICY "Patients can view their own visit summaries" ON public.patient_visit_summaries
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  );

DROP POLICY IF EXISTS "Patients can create manual visit summaries" ON public.patient_visit_summaries;
CREATE POLICY "Patients can create manual visit summaries" ON public.patient_visit_summaries
  FOR INSERT WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
    AND source = 'manual_upload'
  );

DROP POLICY IF EXISTS "System can create link clinic summaries" ON public.patient_visit_summaries;
CREATE POLICY "System can create link clinic summaries" ON public.patient_visit_summaries
  FOR INSERT WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND source = 'link_clinic'
  );

DROP POLICY IF EXISTS "Patients can create their own symptom logs" ON public.patient_symptom_logs;
CREATE POLICY "Patients can create their own symptom logs" ON public.patient_symptom_logs
  FOR INSERT WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  );

DROP POLICY IF EXISTS "Patients can view their own symptom logs" ON public.patient_symptom_logs;
CREATE POLICY "Patients can view their own symptom logs" ON public.patient_symptom_logs
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  );

DROP POLICY IF EXISTS "Patients can view their own appointment requests" ON public.patient_appointment_requests;
CREATE POLICY "Patients can view their own appointment requests" ON public.patient_appointment_requests
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  );

DROP POLICY IF EXISTS "Patients can create appointment requests" ON public.patient_appointment_requests;
CREATE POLICY "Patients can create appointment requests" ON public.patient_appointment_requests
  FOR INSERT WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
    AND EXISTS (
      SELECT 1
      FROM public.facilities f
      WHERE f.id = public.patient_appointment_requests.facility_id
        AND f.tenant_id = public.patient_appointment_requests.tenant_id
    )
  );

DROP POLICY IF EXISTS "Patients can update appointment requests" ON public.patient_appointment_requests;
CREATE POLICY "Patients can update appointment requests" ON public.patient_appointment_requests
  FOR UPDATE USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
  )
  WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
    )
    AND EXISTS (
      SELECT 1
      FROM public.facilities f
      WHERE f.id = public.patient_appointment_requests.facility_id
        AND f.tenant_id = public.patient_appointment_requests.tenant_id
    )
  );

-- Supporting indexes for tenant-aware lookups and patient timeline reads.
CREATE INDEX IF NOT EXISTS idx_patient_accounts_tenant_phone_number
  ON public.patient_accounts(tenant_id, phone_number);
CREATE INDEX IF NOT EXISTS idx_patient_documents_tenant_account
  ON public.patient_documents(tenant_id, patient_account_id);
CREATE INDEX IF NOT EXISTS idx_patient_visit_summaries_tenant_account
  ON public.patient_visit_summaries(tenant_id, patient_account_id);
CREATE INDEX IF NOT EXISTS idx_patient_symptom_logs_tenant_account
  ON public.patient_symptom_logs(tenant_id, patient_account_id);
CREATE INDEX IF NOT EXISTS idx_patient_appointment_requests_tenant_account
  ON public.patient_appointment_requests(tenant_id, patient_account_id);

CREATE INDEX IF NOT EXISTS idx_patient_documents_tenant_account_document_date
  ON public.patient_documents(tenant_id, patient_account_id, document_date DESC);
CREATE INDEX IF NOT EXISTS idx_patient_appointment_requests_tenant_account_requested_date
  ON public.patient_appointment_requests(tenant_id, patient_account_id, requested_date DESC);
CREATE INDEX IF NOT EXISTS idx_patient_symptom_logs_tenant_account_created_at
  ON public.patient_symptom_logs(tenant_id, patient_account_id, created_at DESC);
