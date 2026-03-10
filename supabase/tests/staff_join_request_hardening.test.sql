\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TABLE IF EXISTS public.audit_log CASCADE;
DROP TABLE IF EXISTS public.staff_registration_requests CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;

CREATE TABLE public.facilities (
  id uuid PRIMARY KEY
);

CREATE TABLE public.staff_registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL,
  facility_id uuid NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  requested_role text NOT NULL,
  name text NOT NULL,
  email text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
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

CREATE OR REPLACE FUNCTION public.assert_unique_violation(statement_sql text, failure_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE statement_sql;
    RAISE EXCEPTION '%', failure_message;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.explain_plan_json(query_sql text)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  plan json;
BEGIN
  EXECUTE format('EXPLAIN (FORMAT JSON) %s', query_sql) INTO plan;
  RETURN plan;
END;
$$;

INSERT INTO public.facilities (id) VALUES
  ('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'),
  ('bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb');

-- Seed duplicate pending rows that should be normalized by migration.
INSERT INTO public.staff_registration_requests (
  id, auth_user_id, facility_id, tenant_id, requested_role, name, email, status, requested_at, created_at
)
VALUES
  (
    '10000000-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'nurse',
    'User A',
    'user-a@link.test',
    'pending',
    now() - interval '2 minutes',
    now() - interval '2 minutes'
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'nurse',
    'User A',
    'user-a@link.test',
    'pending',
    now() - interval '1 minute',
    now() - interval '1 minute'
  );

\ir ../migrations/20260215105000_harden_staff_join_request_dedupe_and_audit_trace_index.sql

-- Verify migration normalized existing duplicates.
SELECT public.assert_true(
  (
    SELECT count(*)
    FROM public.staff_registration_requests
    WHERE auth_user_id = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
      AND facility_id = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
      AND status = 'pending'
  ) = 1,
  'Expected exactly one pending staff join request after dedupe migration'
);

SELECT public.assert_true(
  (
    SELECT count(*)
    FROM public.staff_registration_requests
    WHERE auth_user_id = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
      AND facility_id = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
      AND status = 'rejected'
      AND rejection_reason = 'Auto-rejected by migration: duplicate pending request superseded'
  ) = 1,
  'Expected one duplicate pending request to be auto-rejected by migration'
);

-- Duplicate pending insert for the same (auth_user_id, facility_id) must fail.
SELECT public.assert_unique_violation(
  $$
  INSERT INTO public.staff_registration_requests (
    auth_user_id, facility_id, tenant_id, requested_role, name, email, status
  ) VALUES (
    'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'doctor',
    'User A',
    'user-a@link.test',
    'pending'
  )
  $$,
  'Expected unique violation when inserting duplicate pending staff join request'
);

-- Non-pending rows are allowed for the same pair.
INSERT INTO public.staff_registration_requests (
  auth_user_id, facility_id, tenant_id, requested_role, name, email, status
)
VALUES (
  'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'doctor',
  'User A',
  'user-a@link.test',
  'approved'
);

SELECT public.assert_true(
  (
    SELECT count(*)
    FROM public.staff_registration_requests
    WHERE auth_user_id = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
      AND facility_id = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
      AND status = 'approved'
  ) = 1,
  'Expected approved request to coexist with pending dedupe index'
);

-- Pending requests for a different facility should still succeed.
INSERT INTO public.staff_registration_requests (
  auth_user_id, facility_id, tenant_id, requested_role, name, email, status
)
VALUES (
  'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
  'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'doctor',
  'User A',
  'user-a@link.test',
  'pending'
);

SELECT public.assert_true(
  (
    SELECT count(*)
    FROM public.staff_registration_requests
    WHERE auth_user_id = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'
      AND status = 'pending'
  ) = 2,
  'Expected pending requests to be allowed across different facilities'
);

-- Audit request tracing index must exist and be planner-usable.
SELECT public.assert_true(
  to_regclass('public.idx_audit_log_request_id') IS NOT NULL,
  'Expected idx_audit_log_request_id to exist'
);

INSERT INTO public.audit_log (request_id, created_at)
SELECT gen_random_uuid(), now() - (g || ' seconds')::interval
FROM generate_series(1, 300) AS g;

INSERT INTO public.audit_log (request_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

SET enable_seqscan = off;

SELECT public.assert_true(
  public.explain_plan_json(
    'SELECT id FROM public.audit_log WHERE request_id = ''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
  )::text ILIKE '%idx_audit_log_request_id%',
  'Expected audit request-id lookup plan to use idx_audit_log_request_id'
);

RESET enable_seqscan;
