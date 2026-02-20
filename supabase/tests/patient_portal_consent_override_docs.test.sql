\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TABLE IF EXISTS public.patient_portal_consent_history CASCADE;
DROP TABLE IF EXISTS public.patient_portal_consents CASCADE;
DROP TABLE IF EXISTS public.patient_accounts CASCADE;
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

CREATE TABLE public.patient_accounts (
  id uuid PRIMARY KEY,
  phone_number text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  date_of_birth date,
  CONSTRAINT patient_accounts_id_tenant_unique UNIQUE (id, tenant_id),
  CONSTRAINT patient_accounts_tenant_phone_unique UNIQUE (tenant_id, phone_number)
);

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

INSERT INTO public.tenants (id, name) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tenant A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Tenant B');

INSERT INTO public.facilities (id, tenant_id) VALUES
  ('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.patient_accounts (id, phone_number, tenant_id, date_of_birth) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000101', '+11111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1990-01-01'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000102', '+11111111112', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2010-01-01'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-000000000202', '+22222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '1992-02-02');

\ir ../migrations/20260215131500_patient_portal_consents.sql
\ir ../migrations/20260216190000_patient_portal_consent_structured_override_docs_and_rls.sql

GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- Seed a portal consent row for Tenant A adult patient.
INSERT INTO public.patient_portal_consents (
  patient_account_id, tenant_id, facility_id, consent_type, is_active
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'phi_read',
  true
)
RETURNING id AS consent_id_adult \gset

-- RLS: tenant B patient should not see tenant A consent row.
SET ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'tenant_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'phone', '+22222222222')::text,
  false
);

SELECT public.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM public.patient_portal_consents
    WHERE id = :'consent_id_adult'
  ),
  'Cross-tenant patient should not read another tenant portal consent row'
);

-- RLS: tenant A adult patient should see their portal consent row.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'tenant_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'phone', '+11111111111')::text,
  false
);

SELECT public.assert_true(
  EXISTS (
    SELECT 1
    FROM public.patient_portal_consents
    WHERE id = :'consent_id_adult'
  ),
  'Patient should read their own portal consent row'
);

RESET ROLE;

-- Clinical safety gate: grant history must carry comprehension metadata.
SELECT public.assert_raises(
  format(
    $$
    INSERT INTO public.patient_portal_consent_history (
      consent_id, patient_account_id, tenant_id, facility_id, consent_type, action, metadata, actor_role
    ) VALUES (
      %L, %L, %L, %L, %L, 'grant', '{}'::jsonb, 'patient'
    )
    $$,
    :'consent_id_adult',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    'phi_read'
  ),
  'Expected grant history insert to fail when comprehension metadata is missing'
);

-- Low comprehension warning => override required + remediation required.
SELECT public.assert_raises(
  format(
    $$
    INSERT INTO public.patient_portal_consent_history (
      consent_id, patient_account_id, tenant_id, facility_id, consent_type, action, metadata, actor_role
    ) VALUES (
      %L, %L, %L, %L, %L, 'grant',
      jsonb_build_object(
        'comprehensionText', %L,
        'comprehensionLanguage', 'en',
        'comprehensionRecordedAt', now()::text,
        'highRiskOverride', true,
        'overrideReason', 'Override with no remediation evidence'
      ),
      'patient'
    )
    $$,
    :'consent_id_adult',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    'phi_read',
    'I understand and can revoke at any time.'
  ),
  'Expected low comprehension override to fail when remediation documentation is missing'
);

INSERT INTO public.patient_portal_consent_history (
  consent_id, patient_account_id, tenant_id, facility_id, consent_type, action, metadata, actor_role
)
VALUES (
  :'consent_id_adult',
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'phi_read',
  'grant',
  jsonb_build_object(
    'comprehensionText', 'I understand and can revoke at any time.',
    'comprehensionLanguage', 'en',
    'comprehensionRecordedAt', now()::text,
    'highRiskOverride', true,
    'overrideReason', 'Low comprehension override with documented remediation.',
    'lowComprehensionRemediation', 'Teach-back performed; patient repeated the key points correctly.'
  ),
  'patient'
);

-- Language mismatch warning => interpreter used OR language support notes required.
SELECT public.assert_raises(
  format(
    $$
    INSERT INTO public.patient_portal_consent_history (
      consent_id, patient_account_id, tenant_id, facility_id, consent_type, action, metadata, actor_role
    ) VALUES (
      %L, %L, %L, %L, %L, 'grant',
      jsonb_build_object(
        'comprehensionText', %L,
        'comprehensionLanguage', 'am',
        'uiLanguage', 'en',
        'comprehensionRecordedAt', now()::text,
        'highRiskOverride', true,
        'overrideReason', 'Language mismatch override missing language support details.'
      ),
      'patient'
    )
    $$,
    :'consent_id_adult',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    'phi_read',
    repeat('A', 120)
  ),
  'Expected language mismatch override to fail when interpreter/language support documentation is missing'
);

INSERT INTO public.patient_portal_consent_history (
  consent_id, patient_account_id, tenant_id, facility_id, consent_type, action, metadata, actor_role
)
VALUES (
  :'consent_id_adult',
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'phi_read',
  'grant',
  jsonb_build_object(
    'comprehensionText', repeat('A', 120),
    'comprehensionLanguage', 'am',
    'uiLanguage', 'en',
    'comprehensionRecordedAt', now()::text,
    'highRiskOverride', true,
    'overrideReason', 'Language mismatch override with language support notes.',
    'interpreterUsed', false,
    'languageSupportNotes', 'Patient is bilingual in English and Amharic; consent reviewed in both languages.'
  ),
  'patient'
);

-- Minor warning => guardian documentation required.
INSERT INTO public.patient_portal_consents (
  patient_account_id, tenant_id, facility_id, consent_type, is_active
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000102',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'phi_read',
  true
)
RETURNING id AS consent_id_minor \gset

SELECT public.assert_raises(
  format(
    $$
    INSERT INTO public.patient_portal_consent_history (
      consent_id, patient_account_id, tenant_id, facility_id, consent_type, action, metadata, actor_role
    ) VALUES (
      %L, %L, %L, %L, %L, 'grant',
      jsonb_build_object(
        'comprehensionText', %L,
        'comprehensionLanguage', 'en',
        'comprehensionRecordedAt', now()::text,
        'highRiskOverride', true,
        'overrideReason', 'Minor override missing guardian documentation.'
      ),
      'patient'
    )
    $$,
    :'consent_id_minor',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000102',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    'phi_read',
    repeat('B', 120)
  ),
  'Expected minor override to fail when guardian documentation is missing'
);

INSERT INTO public.patient_portal_consent_history (
  consent_id, patient_account_id, tenant_id, facility_id, consent_type, action, metadata, actor_role
)
VALUES (
  :'consent_id_minor',
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000102',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'phi_read',
  'grant',
  jsonb_build_object(
    'comprehensionText', repeat('B', 120),
    'comprehensionLanguage', 'en',
    'comprehensionRecordedAt', now()::text,
    'highRiskOverride', true,
    'overrideReason', 'Minor override with guardian documentation captured.',
    'guardianName', 'Parent One',
    'guardianRelationship', 'Parent',
    'guardianPhone', '0912345678'
  ),
  'patient'
);

-- History is append-only: UPDATE/DELETE must be blocked.
SELECT public.assert_raises(
  format(
    'UPDATE public.patient_portal_consent_history SET reason = %L WHERE consent_id = %L',
    'tamper',
    :'consent_id_adult'
  ),
  'Expected portal consent history update to be blocked'
);

SELECT public.assert_raises(
  format(
    'DELETE FROM public.patient_portal_consent_history WHERE consent_id = %L',
    :'consent_id_adult'
  ),
  'Expected portal consent history delete to be blocked'
);

RESET ROLE;

