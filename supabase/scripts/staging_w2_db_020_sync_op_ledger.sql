-- =============================================================================
-- STAGING APPLY: W2-DB-020 sync_op_ledger
-- Run this in Supabase Dashboard → SQL Editor (staging project)
--
-- This is idempotent — safe to run multiple times.
-- =============================================================================

-- ── 1. Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sync_op_ledger (
  seq            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      UUID        NOT NULL REFERENCES public.tenants(id)    ON DELETE CASCADE,
  facility_id    UUID        NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
  op_id          UUID        NOT NULL,
  device_id      TEXT        NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 128),
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  payload_hash   TEXT        NOT NULL CHECK (char_length(payload_hash) = 64),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.sync_op_ledger              IS 'W2-DB-020: Immutable append-only log of client sync operations.';
COMMENT ON COLUMN public.sync_op_ledger.seq          IS 'Monotonic cursor key — clients pass last-seen seq as ?cursor= on pull.';
COMMENT ON COLUMN public.sync_op_ledger.op_id        IS 'Client-generated UUID, idempotency key.';
COMMENT ON COLUMN public.sync_op_ledger.payload_hash IS 'SHA-256 hex of canonical JSON payload. Used to detect op_id collisions.';

-- ── 2. Indexes ─────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uidx_sync_op_ledger_tenant_facility_op
  ON public.sync_op_ledger (tenant_id, facility_id, op_id);

CREATE INDEX IF NOT EXISTS idx_sync_op_ledger_pull
  ON public.sync_op_ledger (tenant_id, facility_id, seq ASC);

CREATE INDEX IF NOT EXISTS idx_sync_op_ledger_device
  ON public.sync_op_ledger (tenant_id, facility_id, device_id, seq ASC);

-- ── 3. RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.sync_op_ledger ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'sync_op_ledger'
      AND policyname = 'sync_op_ledger_select_own_facility'
  ) THEN
    CREATE POLICY sync_op_ledger_select_own_facility
      ON public.sync_op_ledger FOR SELECT TO authenticated
      USING (
        tenant_id   = (SELECT tenant_id   FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1)
        AND
        facility_id = (SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'sync_op_ledger'
      AND policyname = 'sync_op_ledger_insert_own_facility'
  ) THEN
    CREATE POLICY sync_op_ledger_insert_own_facility
      ON public.sync_op_ledger FOR INSERT TO authenticated
      WITH CHECK (
        tenant_id   = (SELECT tenant_id   FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1)
        AND
        facility_id = (SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1)
      );
  END IF;
END $$;

-- ── 4. Verify ──────────────────────────────────────────────────────────────────

SELECT
  'sync_op_ledger' AS table_name,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sync_op_ledger') AS column_count,
  (SELECT COUNT(*) FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'sync_op_ledger') AS index_count,
  (SELECT COUNT(*) FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'sync_op_ledger') AS policy_count;
