\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Reset schema for repeatable runs
DROP TABLE IF EXISTS public.sync_tombstones CASCADE;
DROP TABLE IF EXISTS public.sync_conflict_audit CASCADE;
DROP TABLE IF EXISTS public.sync_op_ledger CASCADE;
DROP TABLE IF EXISTS public.sync_tenant_revision_counters CASCADE;
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

-- Minimal reference tables / helpers expected by migration RLS policies
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  facility_id uuid REFERENCES public.facilities(id),
  user_role text NOT NULL
);

CREATE OR REPLACE FUNCTION public.get_user_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_user_facility_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(user_role IN ('super_admin'), false)
  FROM public.users
  WHERE auth_user_id = auth.uid()
  LIMIT 1;
$$;

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

INSERT INTO public.tenants (id, name) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tenant A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Tenant B');

INSERT INTO public.facilities (id, tenant_id) VALUES
  ('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-3333-3333-3333-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

-- Users (profiles) with tenant+facility scope
INSERT INTO public.users (auth_user_id, tenant_id, facility_id, user_role) VALUES
  ('aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'doctor'),
  ('aaaaaaaa-0000-0000-0000-aaaaaaaabbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa', 'nurse'),
  ('bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-3333-3333-3333-bbbbbbbbbbbb', 'doctor'),
  ('cccccccc-0000-0000-0000-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, 'super_admin');

\ir ../migrations/20260217150000_w2_sync_primitives_op_ledger_cursor_conflict_audit_tombstones.sql

-- Grant schema/table access so RLS (not privileges) is what gates reads.
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

-- Verify revision allocator is per-tenant monotonic.
SELECT public.assert_true(
  public.allocate_sync_revision('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 1,
  'Expected tenant A first revision to be 1'
);
SELECT public.assert_true(
  public.allocate_sync_revision('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') = 2,
  'Expected tenant A second revision to be 2'
);
SELECT public.assert_true(
  public.allocate_sync_revision('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') = 1,
  'Expected tenant B first revision to be 1'
);

-- Seed op ledger rows (use allocator output for deterministic cursor values).
INSERT INTO public.sync_op_ledger (
  tenant_id, facility_id, revision, op_id, device_id, actor_profile_id,
  entity_type, entity_id, op_kind, client_updated_at, payload
)
VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    10,
    '10000000-0000-0000-0000-000000000001',
    'device-a1',
    NULL,
    'patients',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
    'upsert',
    now(),
    jsonb_build_object('full_name', 'Patient A')
  ),
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa',
    11,
    '10000000-0000-0000-0000-000000000002',
    'device-a2',
    NULL,
    'patients',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000102',
    'upsert',
    now(),
    jsonb_build_object('full_name', 'Patient A2')
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'bbbbbbbb-3333-3333-3333-bbbbbbbbbbbb',
    12,
    '20000000-0000-0000-0000-000000000001',
    'device-b1',
    NULL,
    'patients',
    'bbbbbbbb-bbbb-bbbb-bbbb-000000000202',
    'upsert',
    now(),
    jsonb_build_object('full_name', 'Patient B')
  );

INSERT INTO public.sync_tombstones (
  tenant_id, facility_id, entity_type, entity_id, deleted_revision, deleted_by_op_id, deleted_by_device_id
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'visits',
  'aaaaaaaa-aaaa-aaaa-aaaa-000000009999',
  12,
  '10000000-0000-0000-0000-000000000010',
  'device-a1'
);

INSERT INTO public.sync_conflict_audit (
  tenant_id, facility_id, entity_type, entity_id, field_path,
  winner_revision, winner_op_id, loser_revision, loser_op_id,
  losing_value, winning_value, conflict_reason
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
  'patients',
  'aaaaaaaa-aaaa-aaaa-aaaa-000000000101',
  'phone',
  11,
  '10000000-0000-0000-0000-000000000020',
  10,
  '10000000-0000-0000-0000-000000000021',
  to_jsonb('+251900000001'::text),
  to_jsonb('+251900000999'::text),
  'LWW overwrite'
);

-- RLS: cross-tenant staff should not read tenant A rows.
SET ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb')::text,
  false
);

SELECT public.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM public.sync_op_ledger
    WHERE tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  ),
  'Cross-tenant user must not read op ledger rows'
);

-- RLS: in-tenant but wrong facility should not see facility-scoped rows.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-aaaaaaaabbbb')::text,
  false
);

SELECT public.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM public.sync_op_ledger
    WHERE tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      AND facility_id = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
  ),
  'Wrong-facility user must not read facility-scoped op ledger rows'
);

-- RLS: correct facility can read their rows.
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa')::text,
  false
);

SELECT public.assert_true(
  EXISTS (
    SELECT 1
    FROM public.sync_op_ledger
    WHERE tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      AND facility_id = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
  ),
  'Facility-scoped user should read their op ledger rows'
);

-- Index-backed proof: pull-by-cursor must use tenant+revision index.
SET enable_seqscan = off;

SELECT public.assert_true(
  public.explain_plan_json(
    $$
    SELECT revision, op_id
    FROM public.sync_op_ledger
    WHERE tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      AND revision > 9
    ORDER BY revision
    LIMIT 50
    $$
  )::text ILIKE '%idx_sync_op_ledger_tenant_revision%',
  'Expected pull-by-cursor plan to use idx_sync_op_ledger_tenant_revision'
);

SELECT public.assert_true(
  public.explain_plan_json(
    $$
    SELECT entity_id
    FROM public.sync_tombstones
    WHERE tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
      AND deleted_revision > 1
    ORDER BY deleted_revision
    LIMIT 50
    $$
  )::text ILIKE '%idx_sync_tombstones_tenant_deleted_revision%',
  'Expected tombstone pull plan to use idx_sync_tombstones_tenant_deleted_revision'
);

RESET enable_seqscan;
RESET ROLE;
