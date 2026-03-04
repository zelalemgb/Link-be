-- =============================================================================
-- STAGING SCRIPT — W2-DB-021 Tombstones + Row-Version
-- Paste this entire file into the Supabase Dashboard → SQL Editor and run.
-- Safe to run multiple times (idempotent).
-- =============================================================================

-- 1. Columns
ALTER TABLE public.patients  ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.patients  ADD COLUMN IF NOT EXISTS row_version  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.visits    ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE public.visits    ADD COLUMN IF NOT EXISTS row_version  BIGINT NOT NULL DEFAULT 0;

-- 2. Trigger function: bump version
CREATE OR REPLACE FUNCTION public.bump_row_version_and_sync_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE _new_rev BIGINT;
BEGIN
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

-- 3. Trigger function: tombstone on soft-delete
CREATE OR REPLACE FUNCTION public.on_soft_delete_insert_tombstone()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.deleted_at IS NULL) AND (NEW.deleted_at IS NOT NULL) THEN
    INSERT INTO public.sync_tombstones (
      tenant_id, facility_id, entity_type, entity_id,
      deleted_revision, deleted_at, metadata
    )
    VALUES (
      NEW.tenant_id, NEW.facility_id, TG_TABLE_NAME, NEW.id,
      NEW.row_version, NEW.deleted_at,
      jsonb_build_object('row_version', NEW.row_version, 'updated_at', NEW.updated_at)
    )
    ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE
      SET deleted_revision = EXCLUDED.deleted_revision,
          deleted_at       = EXCLUDED.deleted_at,
          metadata         = EXCLUDED.metadata;
  END IF;
  RETURN NULL;
END;
$$;

-- 4. Triggers — patients
DROP TRIGGER IF EXISTS trg_patients_bump_row_version      ON public.patients;
DROP TRIGGER IF EXISTS trg_patients_soft_delete_tombstone ON public.patients;
CREATE TRIGGER trg_patients_bump_row_version
  BEFORE INSERT OR UPDATE ON public.patients FOR EACH ROW
  EXECUTE FUNCTION public.bump_row_version_and_sync_revision();
CREATE TRIGGER trg_patients_soft_delete_tombstone
  AFTER UPDATE ON public.patients FOR EACH ROW
  EXECUTE FUNCTION public.on_soft_delete_insert_tombstone();

-- 5. Triggers — visits
DROP TRIGGER IF EXISTS trg_visits_bump_row_version        ON public.visits;
DROP TRIGGER IF EXISTS trg_visits_soft_delete_tombstone   ON public.visits;
CREATE TRIGGER trg_visits_bump_row_version
  BEFORE INSERT OR UPDATE ON public.visits FOR EACH ROW
  EXECUTE FUNCTION public.bump_row_version_and_sync_revision();
CREATE TRIGGER trg_visits_soft_delete_tombstone
  AFTER UPDATE ON public.visits FOR EACH ROW
  EXECUTE FUNCTION public.on_soft_delete_insert_tombstone();

-- 6. Indexes
CREATE INDEX IF NOT EXISTS idx_patients_sync_pull    ON public.patients (tenant_id, facility_id, updated_at ASC)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patients_deleted_at   ON public.patients (tenant_id, facility_id, deleted_at)       WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patients_row_version  ON public.patients (tenant_id, id, row_version);
CREATE INDEX IF NOT EXISTS idx_visits_sync_pull      ON public.visits   (tenant_id, facility_id, updated_at ASC)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_visits_deleted_at     ON public.visits   (tenant_id, facility_id, deleted_at)       WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visits_row_version    ON public.visits   (tenant_id, id, row_version);

-- 7. RLS policies
DROP POLICY IF EXISTS "Users can view all patients"              ON public.patients;
DROP POLICY IF EXISTS "Users can view active patients"           ON public.patients;
DROP POLICY IF EXISTS "Admins can view all patients including deleted" ON public.patients;
CREATE POLICY "Users can view active patients"
  ON public.patients FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND (public.is_super_admin() OR facility_id = public.get_user_facility_id()));
CREATE POLICY "Admins can view all patients including deleted"
  ON public.patients FOR SELECT TO authenticated
  USING (public.is_super_admin());

DROP POLICY IF EXISTS "Users can view all visits"    ON public.visits;
DROP POLICY IF EXISTS "facility_visits_select"       ON public.visits;
DROP POLICY IF EXISTS "Users can view active visits" ON public.visits;
CREATE POLICY "Users can view active visits"
  ON public.visits FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND (public.is_super_admin() OR facility_id = public.get_user_facility_id()));

-- =============================================================================
-- VERIFICATION — should return all columns = 1, triggers = 4, indexes = 6
-- =============================================================================
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name='patients' AND column_name='deleted_at')   AS patients_deleted_at,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name='patients' AND column_name='row_version')  AS patients_row_version,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name='visits'   AND column_name='deleted_at')   AS visits_deleted_at,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name='visits'   AND column_name='row_version')  AS visits_row_version,
  (SELECT COUNT(*) FROM information_schema.triggers
   WHERE trigger_schema='public' AND trigger_name IN (
     'trg_patients_bump_row_version','trg_patients_soft_delete_tombstone',
     'trg_visits_bump_row_version',  'trg_visits_soft_delete_tombstone'))                AS trigger_count,
  (SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN (
     'idx_patients_sync_pull','idx_patients_deleted_at','idx_patients_row_version',
     'idx_visits_sync_pull',  'idx_visits_deleted_at',  'idx_visits_row_version'))       AS index_count;
-- Expected: all 1s for columns, trigger_count = 4, index_count = 6
