-- Patient portal security hardening

-- Create dedicated table to track verified patient phone numbers per tenant
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

COMMENT ON TABLE public.patient_portal_phone_verifications IS 'Tracks OTP verification status for patient portal phone numbers per tenant.';

CREATE INDEX IF NOT EXISTS idx_patient_portal_phone_verifications_tenant ON public.patient_portal_phone_verifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_portal_phone_verifications_tenant_phone ON public.patient_portal_phone_verifications(tenant_id, phone_number);

-- Trigger to keep updated_at in sync
DROP TRIGGER IF EXISTS update_patient_portal_phone_verifications_updated_at ON public.patient_portal_phone_verifications;
CREATE TRIGGER update_patient_portal_phone_verifications_updated_at
  BEFORE UPDATE ON public.patient_portal_phone_verifications
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Helper expressions for JWT claims
-- Policies reference tenant_id and phone claims directly to avoid relying on application roles.

-- Refresh patient portal policies to enforce tenant scoping and verified phone checks
ALTER TABLE public.patient_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_visit_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_symptom_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_appointment_requests ENABLE ROW LEVEL SECURITY;

-- Patient accounts policies
DROP POLICY IF EXISTS "Patients can view their own account" ON public.patient_accounts;
CREATE POLICY "Patients can view their own account" ON public.patient_accounts
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
  );

DROP POLICY IF EXISTS "Patients can update their own account" ON public.patient_accounts;
CREATE POLICY "Patients can update their own account" ON public.patient_accounts
  FOR UPDATE USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
  );

DROP POLICY IF EXISTS "Anyone can create patient account" ON public.patient_accounts;
CREATE POLICY "Verified patients can create account" ON public.patient_accounts
  FOR INSERT WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
    AND EXISTS (
      SELECT 1
      FROM public.patient_portal_phone_verifications v
      WHERE v.tenant_id = public.patient_accounts.tenant_id
        AND v.phone_number = public.patient_accounts.phone_number
        AND v.is_verified = true
    )
  );

-- Patient documents policies
DROP POLICY IF EXISTS "Patients can view their own documents" ON public.patient_documents;
CREATE POLICY "Patients can view their own documents" ON public.patient_documents
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
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
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
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
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
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
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
    )
  );

-- Patient visit summaries policies
DROP POLICY IF EXISTS "Patients can view their own visit summaries" ON public.patient_visit_summaries;
CREATE POLICY "Patients can view their own visit summaries" ON public.patient_visit_summaries
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
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
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
    )
    AND source = 'manual_upload'
  );

DROP POLICY IF EXISTS "Patients can create their own symptom logs" ON public.patient_symptom_logs;
CREATE POLICY "Patients can create their own symptom logs" ON public.patient_symptom_logs
  FOR INSERT WITH CHECK (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
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
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
    )
  );

-- Patient appointment requests policies
DROP POLICY IF EXISTS "Patients can view their own appointment requests" ON public.patient_appointment_requests;
CREATE POLICY "Patients can view their own appointment requests" ON public.patient_appointment_requests
  FOR SELECT USING (
    tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id
      FROM public.patient_accounts
      WHERE tenant_id = ((current_setting('request.jwt.claims', true)::json ->> 'tenant_id'))::uuid
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
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
        AND phone_number = current_setting('request.jwt.claims', true)::json ->> 'phone'
    )
  );

-- Supporting indexes for tenant-aware lookups
CREATE INDEX IF NOT EXISTS idx_patient_accounts_tenant_phone_number ON public.patient_accounts(tenant_id, phone_number);
CREATE INDEX IF NOT EXISTS idx_patient_documents_tenant_account ON public.patient_documents(tenant_id, patient_account_id);
CREATE INDEX IF NOT EXISTS idx_patient_visit_summaries_tenant_account ON public.patient_visit_summaries(tenant_id, patient_account_id);
CREATE INDEX IF NOT EXISTS idx_patient_symptom_logs_tenant_account ON public.patient_symptom_logs(tenant_id, patient_account_id);
CREATE INDEX IF NOT EXISTS idx_patient_appointment_requests_tenant_account ON public.patient_appointment_requests(tenant_id, patient_account_id);
