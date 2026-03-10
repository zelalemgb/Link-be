-- =============================================================================
-- W2-DB-020: Sync Op-Ledger
-- Wave 2 offline-first MVP — server-side operation log for push/pull sync
--
-- Tables:
--   sync_op_ledger   — immutable append-only log of every push'd sync op
--
-- Design notes:
--   • seq (BIGSERIAL) is the monotonic cursor key for pull pagination.
--     Clients store the last seq they received and pass it back as ?cursor=.
--   • Idempotency is enforced by UNIQUE (tenant_id, facility_id, op_id).
--     Duplicate ops (same op_id, same payload_hash) are silently ignored.
--     Colliding op_ids with different payloads are rejected at service layer.
--   • payload (JSONB) stores the full op: entityType, entityId, opType, data,
--     clientCreatedAt.  The service extracts fields at read time so the schema
--     stays stable even as the op shape evolves.
--   • payload_hash (SHA-256 of canonical JSON) enables collision detection
--     without re-hashing the JSONB at query time.
--   • RLS: service role (supabaseAdmin) has full access.
--     Authenticated users may only read/insert rows within their own
--     tenant + facility scope.  No UPDATE or DELETE is permitted — the
--     ledger is append-only.
-- =============================================================================

-- ── 1. Table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sync_op_ledger (
  -- Monotonic sequence — used as the cursor for pull pagination
  seq            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Tenant / facility scoping (mirrors the actor scope enforced in the service)
  tenant_id      UUID        NOT NULL REFERENCES public.tenants(id)    ON DELETE CASCADE,
  facility_id    UUID        NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,

  -- Per-device operation identity
  op_id          UUID        NOT NULL,
  device_id      TEXT        NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 128),

  -- Full operation payload (entityType, entityId, opType, data, clientCreatedAt)
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- SHA-256 of canonical JSON payload — used for collision detection
  payload_hash   TEXT        NOT NULL CHECK (char_length(payload_hash) = 64),

  -- Server-assigned ingestion timestamp
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.sync_op_ledger                IS 'W2-DB-020: Immutable append-only log of client sync operations (push/pull).';
COMMENT ON COLUMN public.sync_op_ledger.seq            IS 'Monotonic cursor key for incremental pull. Clients pass last-seen seq as ?cursor=.';
COMMENT ON COLUMN public.sync_op_ledger.op_id          IS 'Client-generated UUID uniquely identifying this operation. Idempotency key.';
COMMENT ON COLUMN public.sync_op_ledger.device_id      IS 'Originating device identifier (max 128 chars).';
COMMENT ON COLUMN public.sync_op_ledger.payload        IS 'Full operation payload: {opId, entityType, entityId, opType, data, clientCreatedAt}.';
COMMENT ON COLUMN public.sync_op_ledger.payload_hash   IS 'SHA-256 hex of canonical JSON payload. Used to detect op_id collisions with different data.';

-- ── 2. Indexes ────────────────────────────────────────────────────────────────

-- Idempotency: reject duplicate (tenant, facility, op_id) at DB level
CREATE UNIQUE INDEX IF NOT EXISTS uidx_sync_op_ledger_tenant_facility_op
  ON public.sync_op_ledger (tenant_id, facility_id, op_id);

-- Pull pagination: primary access pattern is (tenant, facility, seq > cursor)
CREATE INDEX IF NOT EXISTS idx_sync_op_ledger_pull
  ON public.sync_op_ledger (tenant_id, facility_id, seq ASC);

-- Optional: query by device (useful for debugging + audit dashboards)
CREATE INDEX IF NOT EXISTS idx_sync_op_ledger_device
  ON public.sync_op_ledger (tenant_id, facility_id, device_id, seq ASC);

-- ── 3. Row-Level Security ─────────────────────────────────────────────────────

ALTER TABLE public.sync_op_ledger ENABLE ROW LEVEL SECURITY;

-- Service role (supabaseAdmin / service_role): full unrestricted access
-- This is the path used by syncService.ts — bypasses RLS entirely.
-- No explicit policy needed for service_role (Supabase grants it by default).

-- Authenticated users: SELECT rows belonging to their own tenant + facility
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'sync_op_ledger'
      AND policyname = 'sync_op_ledger_select_own_facility'
  ) THEN
    CREATE POLICY sync_op_ledger_select_own_facility
      ON public.sync_op_ledger
      FOR SELECT
      TO authenticated
      USING (
        tenant_id   = (SELECT u.tenant_id FROM public.users u WHERE u.auth_user_id = auth.uid() LIMIT 1)
        AND
        facility_id = (SELECT u.facility_id FROM public.users u WHERE u.auth_user_id = auth.uid() LIMIT 1)
      );
  END IF;
END $$;

-- Authenticated users: INSERT rows for their own tenant + facility only
-- (Defence-in-depth; the service enforces this too, but belt-and-suspenders.)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'sync_op_ledger'
      AND policyname = 'sync_op_ledger_insert_own_facility'
  ) THEN
    CREATE POLICY sync_op_ledger_insert_own_facility
      ON public.sync_op_ledger
      FOR INSERT
      TO authenticated
      WITH CHECK (
        tenant_id   = (SELECT u.tenant_id FROM public.users u WHERE u.auth_user_id = auth.uid() LIMIT 1)
        AND
        facility_id = (SELECT u.facility_id FROM public.users u WHERE u.auth_user_id = auth.uid() LIMIT 1)
      );
  END IF;
END $$;

-- No UPDATE or DELETE policies — the ledger is append-only by design.
