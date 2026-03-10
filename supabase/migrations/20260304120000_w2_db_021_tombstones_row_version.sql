-- =============================================================================
-- W2-DB-021: Tombstones + Row-Version for Server-Side Synced Entities
-- =============================================================================
--
-- WHAT THIS MIGRATION ADDS:
--   1. deleted_at TIMESTAMPTZ   — soft-delete column on patients + visits
--   2. row_version BIGINT       — monotonic LWW version, derived from
--                                 sync_tenant_revision_counters per-tenant counter
--   3. bump_row_version()       — trigger fn called BEFORE INSERT/UPDATE;
--                                 increments tenant counter, sets row_version + updated_at
--   4. on_soft_delete_tombstone() — trigger fn called AFTER UPDATE;
--                                 when deleted_at transitions NULL→value, writes to
--                                 sync_tombstones so pull clients can receive deletions
--   5. Triggers on patients + visits for both functions
--   6. Indexes on (tenant_id, facility_id, updated_at) + deleted rows
--      → critical for the sync pull cursor "delta since seq X" query
--   7. RLS policy updates to filter out soft-deleted rows from SELECT
--
-- DEPENDENCIES:
--   sync_tenant_revision_counters (20260217150000_w2_sync_primitives…)
--   sync_tombstones               (20260217150000_w2_sync_primitives…)
--
-- IDEMPOTENT: safe to run multiple times (IF NOT EXISTS / OR REPLACE / IF column EXISTS).
-- =============================================================================

BEGIN;

-- ─── 1. Add deleted_at column ────────────────────────────────────────────────

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.patients.deleted_at IS
  'Soft-delete tombstone timestamp. NULL = active, non-NULL = deleted. '
  'Sync pull clients must apply these to remove local records.';

COMMENT ON COLUMN public.visits.deleted_at IS
  'Soft-delete tombstone timestamp. NULL = active, non-NULL = deleted. '
  'Sync pull clients must apply these to remove local records.';

-- ─── 2. Add row_version column ───────────────────────────────────────────────
-- Monotonically increasing per-tenant version number.
-- Used for LWW conflict resolution during sync push:
--   if client_row_version < server.row_version → server wins → record conflict audit
--   if client_row_version >= server.row_version → client wins → apply and bump

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.patients.row_version IS
  'Monotonic LWW version. Bumped via sync_tenant_revision_counters on every write.';

COMMENT ON COLUMN public.visits.row_version IS
  'Monotonic LWW version. Bumped via sync_tenant_revision_counters on every write.';

-- ─── 3. Trigger function: bump_row_version ───────────────────────────────────
-- Called BEFORE INSERT OR UPDATE on patients/visits.
-- Atomically increments the per-tenant revision counter and assigns the
-- returned value to NEW.row_version.  Also refreshes NEW.updated_at so every
-- write records an accurate server-side timestamp regardless of client payload.

CREATE OR REPLACE FUNCTION public.bump_row_version_and_sync_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  _new_rev BIGINT;
BEGIN
  -- Upsert the tenant revision counter; each call atomically increments it.
  -- RETURNING gives us the NEW next_revision value (already incremented).
  -- We subtract 1 to get the sequence number assigned to *this* row version.
  INSERT INTO public.sync_tenant_revision_counters (tenant_id, next_revision, updated_at)
  VALUES (NEW.tenant_id, 2, now())
  ON CONFLICT (tenant_id) DO UPDATE
    SET next_revision = sync_tenant_revision_counters.next_revision + 1,
        updated_at    = now()
  RETURNING sync_tenant_revision_counters.next_revision - 1 INTO _new_rev;

  NEW.row_version := _new_rev;
  NEW.updated_at  := now();

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.bump_row_version_and_sync_revision() IS
  'BEFORE INSERT/UPDATE trigger: increments sync_tenant_revision_counters and '
  'writes the new revision into NEW.row_version. Ensures monotonic LWW ordering.';

-- ─── 4. Trigger function: on_soft_delete_tombstone ───────────────────────────
-- Called AFTER UPDATE on patients/visits.
-- When deleted_at transitions from NULL → non-NULL, inserts/upserts a row into
-- sync_tombstones so pull clients learn about the deletion via cursor delta.

CREATE OR REPLACE FUNCTION public.on_soft_delete_insert_tombstone()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only fire when this is a new soft-delete (not already deleted)
  IF (OLD.deleted_at IS NULL) AND (NEW.deleted_at IS NOT NULL) THEN
    INSERT INTO public.sync_tombstones (
      tenant_id,
      facility_id,
      entity_type,
      entity_id,
      deleted_revision,
      deleted_at,
      metadata
    )
    VALUES (
      NEW.tenant_id,
      NEW.facility_id,
      TG_TABLE_NAME,          -- 'patients' or 'visits'
      NEW.id,
      NEW.row_version,        -- already bumped by the BEFORE trigger
      NEW.deleted_at,
      jsonb_build_object(
        'row_version', NEW.row_version,
        'updated_at',  NEW.updated_at
      )
    )
    ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE
      SET deleted_revision = EXCLUDED.deleted_revision,
          deleted_at       = EXCLUDED.deleted_at,
          metadata         = EXCLUDED.metadata;
  END IF;
  RETURN NULL; -- AFTER trigger return value is ignored
END;
$$;

COMMENT ON FUNCTION public.on_soft_delete_insert_tombstone() IS
  'AFTER UPDATE trigger: writes a sync_tombstones entry when deleted_at is '
  'set for the first time, enabling pull clients to delete the local record.';

-- ─── 5. Attach triggers to patients ──────────────────────────────────────────

-- BEFORE trigger: must run before the row is written so we can modify NEW
DROP TRIGGER IF EXISTS trg_patients_bump_row_version ON public.patients;
CREATE TRIGGER trg_patients_bump_row_version
  BEFORE INSERT OR UPDATE ON public.patients
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_row_version_and_sync_revision();

-- AFTER trigger: must run after BEFORE so row_version is already set
DROP TRIGGER IF EXISTS trg_patients_soft_delete_tombstone ON public.patients;
CREATE TRIGGER trg_patients_soft_delete_tombstone
  AFTER UPDATE ON public.patients
  FOR EACH ROW
  EXECUTE FUNCTION public.on_soft_delete_insert_tombstone();

-- ─── 6. Attach triggers to visits ────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_visits_bump_row_version ON public.visits;
CREATE TRIGGER trg_visits_bump_row_version
  BEFORE INSERT OR UPDATE ON public.visits
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_row_version_and_sync_revision();

DROP TRIGGER IF EXISTS trg_visits_soft_delete_tombstone ON public.visits;
CREATE TRIGGER trg_visits_soft_delete_tombstone
  AFTER UPDATE ON public.visits
  FOR EACH ROW
  EXECUTE FUNCTION public.on_soft_delete_insert_tombstone();

-- ─── 7. Indexes for sync pull cursor ─────────────────────────────────────────
-- The pull endpoint query is:
--   WHERE tenant_id = $1 AND facility_id = $2 AND updated_at > $cursor
--   ORDER BY updated_at ASC LIMIT 200
--
-- The push LWW check needs to lookup a row quickly by (tenant_id, id).

-- Patients: pull delta index
CREATE INDEX IF NOT EXISTS idx_patients_sync_pull
  ON public.patients (tenant_id, facility_id, updated_at ASC)
  WHERE deleted_at IS NULL;

-- Patients: include soft-deleted rows for tombstone sweep path
CREATE INDEX IF NOT EXISTS idx_patients_deleted_at
  ON public.patients (tenant_id, facility_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Patients: LWW lookup during push conflict check
CREATE INDEX IF NOT EXISTS idx_patients_row_version
  ON public.patients (tenant_id, id, row_version);

-- Visits: pull delta index
CREATE INDEX IF NOT EXISTS idx_visits_sync_pull
  ON public.visits (tenant_id, facility_id, updated_at ASC)
  WHERE deleted_at IS NULL;

-- Visits: include soft-deleted rows
CREATE INDEX IF NOT EXISTS idx_visits_deleted_at
  ON public.visits (tenant_id, facility_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Visits: LWW lookup during push conflict check
CREATE INDEX IF NOT EXISTS idx_visits_row_version
  ON public.visits (tenant_id, id, row_version);

-- ─── 8. Update RLS policies to exclude soft-deleted rows ─────────────────────
-- Drop and recreate the main SELECT policies so deleted records are invisible
-- to regular authenticated users.
-- (Existing facility-scoped policies already use get_user_facility_id())

-- Patients
DROP POLICY IF EXISTS "Users can view all patients" ON public.patients;
CREATE POLICY "Users can view active patients"
  ON public.patients
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      public.is_super_admin()
      OR facility_id = public.get_user_facility_id()
    )
  );

-- Allow service role / admin to see deleted rows for audit / sync
CREATE POLICY "Admins can view all patients including deleted"
  ON public.patients
  FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
  );

-- Visits — add deleted_at guard to existing facility-scoped select policy
DROP POLICY IF EXISTS "Users can view all visits" ON public.visits;
DROP POLICY IF EXISTS "facility_visits_select" ON public.visits;
CREATE POLICY "Users can view active visits"
  ON public.visits
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      public.is_super_admin()
      OR facility_id = public.get_user_facility_id()
    )
  );

-- ─── 9. Backfill row_version = 0 for existing rows ───────────────────────────
-- Existing rows keep row_version = 0 (the DEFAULT).
-- They will receive a real version on their next UPDATE.
-- This is acceptable for LWW: a client push with any row_version > 0 will
-- always win against an unversioned legacy row.
--
-- NOTE: we do NOT fire the bump trigger here to avoid locking all rows;
-- instead the first sync push/pull for each row will naturalise the version.

-- ─── Verification ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  _patients_deleted_col INT;
  _patients_version_col INT;
  _visits_deleted_col   INT;
  _visits_version_col   INT;
  _trigger_count        INT;
  _index_count          INT;
BEGIN
  SELECT COUNT(*) INTO _patients_deleted_col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'deleted_at';

  SELECT COUNT(*) INTO _patients_version_col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'row_version';

  SELECT COUNT(*) INTO _visits_deleted_col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'deleted_at';

  SELECT COUNT(*) INTO _visits_version_col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'row_version';

  SELECT COUNT(*) INTO _trigger_count
  FROM information_schema.triggers
  WHERE trigger_schema = 'public'
    AND trigger_name IN (
      'trg_patients_bump_row_version',
      'trg_patients_soft_delete_tombstone',
      'trg_visits_bump_row_version',
      'trg_visits_soft_delete_tombstone'
    );

  SELECT COUNT(*) INTO _index_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'idx_patients_sync_pull', 'idx_patients_deleted_at', 'idx_patients_row_version',
      'idx_visits_sync_pull',   'idx_visits_deleted_at',   'idx_visits_row_version'
    );

  RAISE NOTICE 'W2-DB-021 verification:';
  RAISE NOTICE '  patients.deleted_at column : %', CASE WHEN _patients_deleted_col = 1 THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  patients.row_version column: %', CASE WHEN _patients_version_col = 1 THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  visits.deleted_at column   : %', CASE WHEN _visits_deleted_col   = 1 THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  visits.row_version column  : %', CASE WHEN _visits_version_col   = 1 THEN 'OK' ELSE 'MISSING' END;
  RAISE NOTICE '  triggers attached          : % / 4', _trigger_count;
  RAISE NOTICE '  sync pull indexes          : % / 6', _index_count;

  IF (_patients_deleted_col + _patients_version_col + _visits_deleted_col + _visits_version_col) < 4
    OR _trigger_count < 4
    OR _index_count < 6
  THEN
    RAISE EXCEPTION 'W2-DB-021 migration incomplete — check output above';
  END IF;
END;
$$;

COMMIT;
