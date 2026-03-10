\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Minimal helper trigger used by migrations
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Reset schema objects for repeatable runs
DROP TABLE IF EXISTS public.patient_appointment_requests CASCADE;
DROP TABLE IF EXISTS public.patient_symptom_logs CASCADE;
DROP TABLE IF EXISTS public.patient_visit_summaries CASCADE;
DROP TABLE IF EXISTS public.patient_documents CASCADE;
DROP TABLE IF EXISTS public.patient_accounts CASCADE;
DROP TABLE IF EXISTS public.patient_portal_phone_verifications CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.tenants CASCADE;

-- Minimal reference tables
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

CREATE TABLE public.facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id)
);

-- Patient portal tables (subset of production schema)
CREATE TABLE public.patient_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  phone_number TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.patient_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  patient_account_id UUID NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  document_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.patient_visit_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  patient_account_id UUID NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.patient_symptom_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  patient_account_id UUID NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  symptom_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.patient_appointment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  patient_account_id UUID NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  requested_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable row level security to match production
ALTER TABLE public.patient_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_visit_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_symptom_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_appointment_requests ENABLE ROW LEVEL SECURITY;

-- Apply patient portal policy migration
\ir ../migrations/20260215102000_patient_portal_security_hardening.sql

-- Helper procedure to assert that a command fails due to policy or constraint enforcement
CREATE OR REPLACE PROCEDURE public.assert_policy_denied(command TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  err_code TEXT;
BEGIN
  EXECUTE command;
  RAISE EXCEPTION 'Statement succeeded but should have been denied: %', command;
EXCEPTION
  WHEN others THEN
    GET STACKED DIAGNOSTICS err_code = RETURNED_SQLSTATE;
    IF err_code NOT IN ('42501', '23514', '23503', '23505', 'P0001') THEN
      RAISE;
    END IF;
END;
$$;

-- Create roles used in tests
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'patient_role') THEN
    CREATE ROLE patient_role;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO patient_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO patient_role;

-- Seed tenants and facilities
INSERT INTO public.tenants (name) VALUES ('Tenant One') RETURNING id::text AS tenant_one_id \gset
INSERT INTO public.tenants (name) VALUES ('Tenant Two') RETURNING id::text AS tenant_two_id \gset

INSERT INTO public.facilities (tenant_id) VALUES (:'tenant_one_id'::uuid) RETURNING id::text AS facility_one_id \gset
INSERT INTO public.facilities (tenant_id) VALUES (:'tenant_two_id'::uuid) RETURNING id::text AS facility_two_id \gset

\set patient_one_phone '+15550001111'
\set patient_two_phone '+15550002222'
\set unverified_phone '+15550003333'

-- Insert verification records (service context)
INSERT INTO public.patient_portal_phone_verifications (tenant_id, phone_number, is_verified, verified_at)
VALUES
  (:'tenant_one_id'::uuid, :'patient_one_phone', true, now()),
  (:'tenant_two_id'::uuid, :'patient_two_phone', true, now());

-- Consent/verification state must be internally consistent.
CALL public.assert_policy_denied(
  format(
    $$INSERT INTO public.patient_portal_phone_verifications (tenant_id, phone_number, is_verified, verified_at)
      VALUES (%L::uuid, %L, true, NULL)$$,
    :'tenant_one_id', '+15550009991'
  )
);
CALL public.assert_policy_denied(
  format(
    $$INSERT INTO public.patient_portal_phone_verifications (tenant_id, phone_number, is_verified, verified_at)
      VALUES (%L::uuid, %L, false, now())$$,
    :'tenant_one_id', '+15550009992'
  )
);

-- Prepare JWT claim payloads
SELECT jsonb_build_object('tenant_id', :'tenant_one_id'::uuid, 'phone', :'patient_one_phone')::text AS claims_patient_one \gset
SELECT jsonb_build_object('tenant_id', :'tenant_two_id'::uuid, 'phone', :'patient_two_phone')::text AS claims_patient_two \gset
SELECT jsonb_build_object('tenant_id', :'tenant_one_id'::uuid, 'phone', :'unverified_phone')::text AS claims_unverified \gset

-- Helper: enable row security for the session
SET row_security = on;

-- Patient one can create account after verification
SET ROLE patient_role;
SET "request.jwt.claims" = :'claims_patient_one';
INSERT INTO public.patient_accounts (tenant_id, phone_number, name)
VALUES (:'tenant_one_id'::uuid, :'patient_one_phone', 'Patient One')
RETURNING id::text AS patient_one_account_id \gset

-- Patient two can create account after verification
SET "request.jwt.claims" = :'claims_patient_two';
INSERT INTO public.patient_accounts (tenant_id, phone_number, name)
VALUES (:'tenant_two_id'::uuid, :'patient_two_phone', 'Patient Two')
RETURNING id::text AS patient_two_account_id \gset

-- Unverified phone cannot create account
SET "request.jwt.claims" = :'claims_unverified';
CALL public.assert_policy_denied(
  format(
    $$INSERT INTO public.patient_accounts (tenant_id, phone_number, name) VALUES (%L::uuid, %L, 'Should Fail')$$,
    :'tenant_one_id', :'unverified_phone'
  )
);

-- Patient one cannot spoof tenant on insert
SET "request.jwt.claims" = :'claims_patient_one';
CALL public.assert_policy_denied(
  format(
    $$INSERT INTO public.patient_accounts (tenant_id, phone_number, name) VALUES (%L::uuid, %L, 'Wrong Tenant')$$,
    :'tenant_two_id', :'patient_one_phone'
  )
);

-- Patient one can manage own documents
SET "request.jwt.claims" = :'claims_patient_one';
INSERT INTO public.patient_documents (tenant_id, patient_account_id, document_type, file_url, document_date)
VALUES (:'tenant_one_id'::uuid, :'patient_one_account_id'::uuid, 'lab', 'https://example.com/lab.pdf', current_date)
RETURNING id::text AS patient_one_document_id \gset

-- Patient two cannot access patient one's document (select)
SET "request.jwt.claims" = :'claims_patient_two';
CALL public.assert_policy_denied(
  format(
    $$SELECT 1 FROM public.patient_documents WHERE id = %L::uuid$$,
    :'patient_one_document_id'
  )
);

-- Patient two cannot insert document for patient one
CALL public.assert_policy_denied(
  format(
    $$INSERT INTO public.patient_documents (tenant_id, patient_account_id, document_type, file_url, document_date)
      VALUES (%L::uuid, %L::uuid, 'lab', 'https://example.com/should_fail.pdf', current_date)$$,
    :'tenant_one_id', :'patient_one_account_id'
  )
);

-- Patient one can view and update own account but not patient two's account
SET "request.jwt.claims" = :'claims_patient_one';
SELECT name FROM public.patient_accounts WHERE id = :'patient_one_account_id'::uuid;
CALL public.assert_policy_denied(
  format(
    $$UPDATE public.patient_accounts SET name = 'Hacker' WHERE id = %L::uuid$$,
    :'patient_two_account_id'
  )
);

-- Patient one cannot delete patient two's document
CALL public.assert_policy_denied(
  format(
    $$DELETE FROM public.patient_documents WHERE tenant_id = %L::uuid AND patient_account_id = %L::uuid$$,
    :'tenant_two_id', :'patient_two_account_id'
  )
);

-- Patient one can insert appointment request for own account only
INSERT INTO public.patient_appointment_requests (tenant_id, patient_account_id, facility_id, requested_date)
VALUES (:'tenant_one_id'::uuid, :'patient_one_account_id'::uuid, :'facility_one_id'::uuid, current_date);
CALL public.assert_policy_denied(
  format(
    $$INSERT INTO public.patient_appointment_requests (tenant_id, patient_account_id, facility_id, requested_date)
      VALUES (%L::uuid, %L::uuid, %L::uuid, current_date)$$,
    :'tenant_two_id', :'patient_one_account_id', :'facility_two_id'
  )
);

-- Tenant consistency constraints must reject cross-tenant child inserts even in service context.
RESET ROLE;
SET row_security = off;
CALL public.assert_policy_denied(
  format(
    $$INSERT INTO public.patient_documents (tenant_id, patient_account_id, document_type, file_url, document_date)
      VALUES (%L::uuid, %L::uuid, 'lab', 'https://example.com/tenant-mismatch.pdf', current_date)$$,
    :'tenant_two_id', :'patient_one_account_id'
  )
);
CALL public.assert_policy_denied(
  format(
    $$INSERT INTO public.patient_appointment_requests (tenant_id, patient_account_id, facility_id, requested_date)
      VALUES (%L::uuid, %L::uuid, %L::uuid, current_date)$$,
    :'tenant_one_id', :'patient_one_account_id', :'facility_two_id'
  )
);

RESET ROLE;
RESET "request.jwt.claims";
RESET row_security;
