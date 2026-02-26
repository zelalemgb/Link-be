\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP TABLE IF EXISTS public.visits CASCADE;

CREATE TABLE public.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  facility_id uuid,
  tenant_id uuid NOT NULL,
  assigned_doctor uuid,
  status text,
  visit_notes text,
  visit_date timestamptz NOT NULL
);

-- Baseline indexes that existed before W2-DB-HISTORY-PERF-003.
CREATE INDEX IF NOT EXISTS idx_visits_patient_date
  ON public.visits (patient_id, visit_date DESC);

CREATE INDEX IF NOT EXISTS idx_visits_tenant_facility
  ON public.visits (tenant_id, facility_id);

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

\ir ../migrations/20260220101500_w2_db_history_perf_003_doctor_history_index.sql

INSERT INTO public.visits (
  id,
  patient_id,
  facility_id,
  tenant_id,
  assigned_doctor,
  status,
  visit_notes,
  visit_date
)
VALUES
  (
    '99999999-0000-0000-0000-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'with_doctor',
    '{"seed":"current"}',
    now()
  );

-- Seed many rows for one patient across multiple facilities to make
-- facility-scoped history reads meaningfully selective.
INSERT INTO public.visits (
  patient_id,
  facility_id,
  tenant_id,
  assigned_doctor,
  status,
  visit_notes,
  visit_date
)
SELECT
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  CASE WHEN (g % 10) = 0
    THEN 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'::uuid
    ELSE 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa'::uuid
  END,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
  'with_doctor',
  '{"seed":"bulk"}',
  now() - (g || ' minutes')::interval
FROM generate_series(1, 30000) AS g;

ANALYZE public.visits;

SET enable_seqscan = off;

-- Proof: doctor history read path uses new composite index.
SELECT public.assert_true(
  public.explain_plan_json(
    $$
    SELECT id, visit_date
    FROM public.visits
    WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
      AND facility_id = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
      AND patient_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    ORDER BY visit_date DESC
    LIMIT 10
    $$
  )::text ILIKE '%idx_visits_tenant_facility_patient_date_desc%',
  'Expected doctor history read query to use idx_visits_tenant_facility_patient_date_desc'
);

-- Proof: doctor history write path remains PK-driven for id-scoped mutation.
SELECT public.assert_true(
  public.explain_plan_json(
    $$
    UPDATE public.visits
    SET visit_notes = '{"updated":"yes"}'
    WHERE id = '99999999-0000-0000-0000-000000000001'
      AND facility_id = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
      AND tenant_id = '11111111-1111-1111-1111-111111111111'
    $$
  )::text ILIKE '%visits_pkey%',
  'Expected doctor history write query to remain primary-key driven'
);

RESET enable_seqscan;

