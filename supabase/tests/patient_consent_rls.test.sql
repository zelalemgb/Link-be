\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TABLE IF EXISTS public.patient_data_consent_history CASCADE;
DROP TABLE IF EXISTS public.patient_data_consents CASCADE;
DROP TABLE IF EXISTS public.patient_symptom_logs CASCADE;
DROP TABLE IF EXISTS public.patient_visit_summaries CASCADE;
DROP TABLE IF EXISTS public.patient_documents CASCADE;
DROP TABLE IF EXISTS public.patient_accounts CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.tenants CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;

CREATE SCHEMA auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid, gen_random_uuid());
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.facilities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  CONSTRAINT facilities_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  facility_id uuid REFERENCES public.facilities(id),
  user_role text NOT NULL
);

CREATE TABLE public.patient_accounts (
  id uuid PRIMARY KEY,
  phone_number text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  CONSTRAINT patient_accounts_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE TABLE public.patient_documents (
  id uuid PRIMARY KEY,
  patient_account_id uuid NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  file_url text NOT NULL
);

CREATE TABLE public.patient_visit_summaries (
  id uuid PRIMARY KEY,
  patient_account_id uuid NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  summary_text text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.patient_symptom_logs (
  id uuid PRIMARY KEY,
  patient_account_id uuid NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  symptom_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.patient_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_visit_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_symptom_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Patients can view their own account" ON public.patient_accounts
  FOR SELECT USING (
    tenant_id = ((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'tenant_id'))::uuid
    AND phone_number = (NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'phone')
  );

CREATE POLICY "Patients can view their own documents" ON public.patient_documents
  FOR SELECT USING (
    tenant_id = ((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE tenant_id = ((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'tenant_id'))::uuid
        AND phone_number = (NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'phone')
    )
  );

CREATE POLICY "Patients can view their own visit summaries" ON public.patient_visit_summaries
  FOR SELECT USING (
    tenant_id = ((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE tenant_id = ((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'tenant_id'))::uuid
        AND phone_number = (NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'phone')
    )
  );

CREATE POLICY "Patients can view their own symptom logs" ON public.patient_symptom_logs
  FOR SELECT USING (
    tenant_id = ((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'tenant_id'))::uuid
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE tenant_id = ((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'tenant_id'))::uuid
        AND phone_number = (NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'phone')
    )
  );

INSERT INTO public.tenants (id, name) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tenant A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Tenant B');

INSERT INTO public.facilities (id, tenant_id) VALUES
  ('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.users (id, auth_user_id, tenant_id, facility_id, user_role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000001', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'doctor'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000002', 'aaaaaaaa-0000-0000-0000-aaaaaaaabbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'nurse'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-000000000001', 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', 'doctor');

INSERT INTO public.patient_accounts (id, phone_number, tenant_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000101', '+11111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-000000000202', '+22222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.patient_documents (id, patient_account_id, tenant_id, file_url) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000001001', 'aaaaaaaa-aaaa-aaaa-aaaa-000000000101', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'https://tenant-a/doc1.pdf'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-000000002002', 'bbbbbbbb-bbbb-bbbb-bbbb-000000000202', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'https://tenant-b/doc2.pdf');

INSERT INTO public.patient_visit_summaries (id, patient_account_id, tenant_id, summary_text) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000003003', 'aaaaaaaa-aaaa-aaaa-aaaa-000000000101', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Summary A');

INSERT INTO public.patient_symptom_logs (id, patient_account_id, tenant_id, symptom_data) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000004004', 'aaaaaaaa-aaaa-aaaa-aaaa-000000000101', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"pain":true}');

\ir ../migrations/20260215120000_patient_consent_management_and_rls.sql
\ir ../migrations/20260215133000_consent_clinical_safety_fields_and_indexes.sql

GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT CREATE ON SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

SET ROLE authenticated;

CREATE OR REPLACE FUNCTION public.assert_true(condition boolean, failure_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT condition THEN
    RAISE EXCEPTION '%', failure_message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_policy_denied(statement_sql text, failure_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE statement_sql;
    RAISE EXCEPTION '%', failure_message;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RETURN;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_raises(statement_sql text, failure_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE statement_sql;
    RAISE EXCEPTION '%', failure_message;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_zero_rows_affected(statement_sql text, failure_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  affected_rows integer;
BEGIN
  EXECUTE statement_sql;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION '%', failure_message;
  END IF;
END;
$$;

-- Cross-tenant staff access must be denied without consent.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'tenant_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')::text,
  false
);

SELECT public.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.patient_documents
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000001001'
  ),
  'Cross-tenant provider should not access tenant A patient document'
);

-- Patient grant to provider should unlock access.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'cccccccc-0000-0000-0000-cccccccccccc', 'tenant_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'phone', '+11111111111')::text,
  false
);

INSERT INTO public.patient_data_consents (
  patient_account_id,
  tenant_id,
  grantee_scope,
  provider_user_id,
  comprehension_text,
  comprehension_language,
  comprehension_recorded_at,
  granted_by_auth_user_id,
  status
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'provider',
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
  'I understand my data will be shared with this provider for clinical care and I can revoke at any time.',
  'en',
  now(),
  'cccccccc-0000-0000-0000-cccccccccccc',
  'granted'
)
RETURNING id AS provider_consent_id \gset

-- Clinical safety gate: comprehension fields required for consent capture.
SELECT public.assert_raises(
  $$
  INSERT INTO public.patient_data_consents (
    patient_account_id,
    tenant_id,
    grantee_scope,
    provider_user_id,
    granted_by_auth_user_id,
    status
  ) VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'provider',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
    'cccccccc-0000-0000-0000-cccccccccccc',
    'granted'
  )
  $$,
  'Expected consent grant to be rejected when comprehension fields are missing'
);

-- Cross-tenant patient cannot manipulate another tenant's consent.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'dddddddd-0000-0000-0000-dddddddddddd', 'tenant_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'phone', '+22222222222')::text,
  false
);

SELECT public.assert_zero_rows_affected(
  format(
    'UPDATE public.patient_data_consents SET status = ''revoked'' WHERE id = %L',
    :'provider_consent_id'
  ),
  'Cross-tenant patient update must affect zero consent rows'
);

-- Provider in-tenant can access after grant.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'tenant_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text,
  false
);

SELECT public.assert_true(
  EXISTS (
    SELECT 1 FROM public.patient_documents
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000001001'
  ),
  'Provider should access patient document after consent grant'
);

-- Revoke should have immediate effect.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'cccccccc-0000-0000-0000-cccccccccccc', 'tenant_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'phone', '+11111111111')::text,
  false
);

UPDATE public.patient_data_consents
SET
  status = 'revoked',
  revoke_acknowledged = true,
  revoked_reason = 'Patient requested stop sharing',
  revoked_by_auth_user_id = 'cccccccc-0000-0000-0000-cccccccccccc'
WHERE id = :'provider_consent_id';

SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'tenant_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text,
  false
);

SELECT public.assert_true(
  NOT EXISTS (
    SELECT 1 FROM public.patient_documents
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000001001'
  ),
  'Provider access must be blocked immediately after consent revoke'
);

-- Facility-scoped grant should allow same-facility staff access.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'cccccccc-0000-0000-0000-cccccccccccc', 'tenant_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'phone', '+11111111111')::text,
  false
);

INSERT INTO public.patient_data_consents (
  patient_account_id,
  tenant_id,
  grantee_scope,
  facility_id,
  comprehension_text,
  comprehension_language,
  comprehension_recorded_at,
  granted_by_auth_user_id,
  status
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'facility',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'I understand my data will be shared with the facility care team for coordination. I can revoke at any time.',
  'en',
  now(),
  'cccccccc-0000-0000-0000-cccccccccccc',
  'granted'
)
RETURNING id AS facility_consent_id \gset

-- Clinical safety gate: revoke must include explicit acknowledgment + reason.
-- Use facility consent (still granted) to prove the constraint blocks unsafe revoke.
SELECT public.assert_raises(
  'UPDATE public.patient_data_consents SET status = ''revoked'', revoked_reason = ''no ack'' WHERE id = '''
  || :'facility_consent_id'
  || '''',
  'Expected revoke to be rejected when revoke_acknowledged is missing'
);

-- Clinical safety gate: high-risk override requires override documentation.
SELECT public.assert_raises(
  $$
  INSERT INTO public.patient_data_consents (
    patient_account_id,
    tenant_id,
    grantee_scope,
    provider_user_id,
    comprehension_text,
    comprehension_language,
    comprehension_recorded_at,
    high_risk_flag,
    granted_by_auth_user_id,
    status
  ) VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'provider',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
    'I understand and accept the risks of sharing.',
    'en',
    now(),
    true,
    'cccccccc-0000-0000-0000-cccccccccccc',
    'granted'
  )
  $$,
  'Expected high-risk consent to be rejected when override fields are missing'
);

INSERT INTO public.patient_data_consents (
  patient_account_id,
  tenant_id,
  grantee_scope,
  provider_user_id,
  comprehension_text,
  comprehension_language,
  comprehension_recorded_at,
  high_risk_flag,
  override_reason,
  override_actor_auth_user_id,
  override_at,
  granted_by_auth_user_id,
  status
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'provider',
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
  'I understand the risks and accept sharing due to urgent clinical need.',
  'en',
  now(),
  true,
  'Urgent care override with documented patient agreement.',
  'cccccccc-0000-0000-0000-cccccccccccc',
  now(),
  'cccccccc-0000-0000-0000-cccccccccccc',
  'granted'
);

SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-aaaaaaaabbbb', 'tenant_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text,
  false
);

SELECT public.assert_true(
  EXISTS (
    SELECT 1 FROM public.patient_documents
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000001001'
  ),
  'Facility-scoped consent should allow same-facility staff document access'
);

-- Consent history integrity checks.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'cccccccc-0000-0000-0000-cccccccccccc', 'tenant_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'phone', '+11111111111')::text,
  false
);

SELECT public.assert_true(
  (
    SELECT count(*)
    FROM public.patient_data_consent_history
    WHERE consent_id = :'provider_consent_id'
      AND action = 'granted'
  ) = 1,
  'Expected one granted history event for provider consent'
);

SELECT public.assert_true(
  (
    SELECT count(*)
    FROM public.patient_data_consent_history
    WHERE consent_id = :'provider_consent_id'
      AND action = 'revoked'
  ) = 1,
  'Expected one revoked history event for provider consent'
);

-- History ordering signal (granted before revoked by action_at timestamps).
SELECT public.assert_true(
  (
    SELECT min(action_at) < max(action_at)
    FROM public.patient_data_consent_history
    WHERE consent_id = :'provider_consent_id'
  ),
  'Expected consent history action_at to be ordered (granted before revoked)'
);

SELECT public.assert_raises(
  'UPDATE public.patient_data_consent_history SET note = ''tamper'' WHERE consent_id = ''' || :'provider_consent_id' || '''',
  'Expected consent history update to be blocked'
);

SELECT public.assert_raises(
  'DELETE FROM public.patient_data_consent_history WHERE consent_id = ''' || :'provider_consent_id' || '''',
  'Expected consent history delete to be blocked'
);

RESET ROLE;
