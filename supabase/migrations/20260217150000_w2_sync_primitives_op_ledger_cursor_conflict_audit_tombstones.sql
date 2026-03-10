-- Wave 2 (Offline-First MVP): W2-DB-020/021/022 sync primitives.
-- Goal: deterministic pull-by-cursor, conflict audit capture, tombstones/versioning strategy, and RLS isolation.

-- 1) Per-tenant monotonic cursor allocator (commit-order safe via row lock).
CREATE TABLE IF NOT EXISTS public.sync_tenant_revision_counters (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  next_revision bigint NOT NULL DEFAULT 1 CHECK (next_revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.allocate_sync_revision(p_tenant_id uuid)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_allocated bigint;
BEGIN
  -- Ensure row exists without taking a long lock; the UPDATE below serializes per tenant.
  INSERT INTO public.sync_tenant_revision_counters (tenant_id, next_revision, updated_at)
  VALUES (p_tenant_id, 1, now())
  ON CONFLICT (tenant_id) DO NOTHING;

  UPDATE public.sync_tenant_revision_counters
  SET
    next_revision = next_revision + 1,
    updated_at = now()
  WHERE tenant_id = p_tenant_id
  RETURNING next_revision - 1 INTO v_allocated;

  RETURN v_allocated;
END;
$$;

COMMENT ON FUNCTION public.allocate_sync_revision(uuid) IS
  'Allocates a per-tenant monotonically increasing revision for sync pull cursors. Safe for cursor queries because allocation is serialized per tenant.';

-- 2) Operation ledger (append-only).
CREATE TABLE IF NOT EXISTS public.sync_op_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id uuid,
  revision bigint NOT NULL CHECK (revision > 0),
  op_id uuid NOT NULL,
  device_id text,
  actor_profile_id uuid,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  op_kind text NOT NULL CHECK (op_kind IN ('upsert', 'delete')),
  client_updated_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_op_ledger_facility_tenant_fkey
    FOREIGN KEY (facility_id, tenant_id)
    REFERENCES public.facilities(id, tenant_id)
    ON DELETE SET NULL,
  CONSTRAINT sync_op_ledger_tenant_revision_unique UNIQUE (tenant_id, revision),
  CONSTRAINT sync_op_ledger_tenant_op_unique UNIQUE (tenant_id, op_id)
);

COMMENT ON TABLE public.sync_op_ledger IS
  'Append-only operation ledger for offline sync. Used for deterministic pull-by-cursor (tenant_id + revision).';

-- Pull path: WHERE tenant_id = ? AND revision > ? ORDER BY revision LIMIT ?
CREATE INDEX IF NOT EXISTS idx_sync_op_ledger_tenant_revision
  ON public.sync_op_ledger (tenant_id, revision);

-- Common query: latest ops for an entity (debug/conflict support).
CREATE INDEX IF NOT EXISTS idx_sync_op_ledger_tenant_entity_revision_desc
  ON public.sync_op_ledger (tenant_id, entity_type, entity_id, revision DESC);

-- 3) Conflict audit ("losing value" capture for LWW).
CREATE TABLE IF NOT EXISTS public.sync_conflict_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id uuid,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  field_path text NOT NULL,
  winner_revision bigint NOT NULL CHECK (winner_revision > 0),
  winner_op_id uuid,
  loser_revision bigint NOT NULL CHECK (loser_revision > 0),
  loser_op_id uuid,
  losing_value jsonb,
  winning_value jsonb,
  conflict_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_conflict_audit_facility_tenant_fkey
    FOREIGN KEY (facility_id, tenant_id)
    REFERENCES public.facilities(id, tenant_id)
    ON DELETE SET NULL
);

COMMENT ON TABLE public.sync_conflict_audit IS
  'LWW conflict audit trail: stores losing values when a concurrent write is overridden.';

CREATE INDEX IF NOT EXISTS idx_sync_conflict_audit_tenant_created_at
  ON public.sync_conflict_audit (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_conflict_audit_tenant_entity_created_at
  ON public.sync_conflict_audit (tenant_id, entity_type, entity_id, created_at DESC);

-- 4) Tombstones for deleted entities (so deletes can be pulled even if source rows are hard-deleted).
CREATE TABLE IF NOT EXISTS public.sync_tombstones (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id uuid,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  deleted_revision bigint NOT NULL CHECK (deleted_revision > 0),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by_op_id uuid,
  deleted_by_device_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, entity_type, entity_id),
  CONSTRAINT sync_tombstones_facility_tenant_fkey
    FOREIGN KEY (facility_id, tenant_id)
    REFERENCES public.facilities(id, tenant_id)
    ON DELETE SET NULL
);

COMMENT ON TABLE public.sync_tombstones IS
  'Deletion markers for synced entities. Pull clients must apply these to remove local records.';

-- Pull path: WHERE tenant_id = ? AND deleted_revision > ? ORDER BY deleted_revision LIMIT ?
CREATE INDEX IF NOT EXISTS idx_sync_tombstones_tenant_deleted_revision
  ON public.sync_tombstones (tenant_id, deleted_revision);

-- 5) RLS isolation for sync tables (tenant + facility scoped reads).
-- NOTE: service_role can bypass RLS in Supabase; backend must still enforce scope explicitly.
ALTER TABLE public.sync_op_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_conflict_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_tombstones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sync: tenant/facility can read op ledger" ON public.sync_op_ledger;
CREATE POLICY "Sync: tenant/facility can read op ledger" ON public.sync_op_ledger
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_user_tenant_id()
    AND (
      facility_id IS NULL
      OR facility_id = public.get_user_facility_id()
      OR public.is_super_admin()
    )
  );

DROP POLICY IF EXISTS "Sync: tenant/facility can read conflict audit" ON public.sync_conflict_audit;
CREATE POLICY "Sync: tenant/facility can read conflict audit" ON public.sync_conflict_audit
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_user_tenant_id()
    AND (
      facility_id IS NULL
      OR facility_id = public.get_user_facility_id()
      OR public.is_super_admin()
    )
  );

DROP POLICY IF EXISTS "Sync: tenant/facility can read tombstones" ON public.sync_tombstones;
CREATE POLICY "Sync: tenant/facility can read tombstones" ON public.sync_tombstones
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_user_tenant_id()
    AND (
      facility_id IS NULL
      OR facility_id = public.get_user_facility_id()
      OR public.is_super_admin()
    )
  );

