-- ============================================================
-- FIX 11 — CRITICAL: Automatic PHI Audit Log Triggers
-- ============================================================
-- Problem:
--   The audit_log table is well-designed but nothing writes to it
--   automatically. Any direct DB access, background job, or migration
--   that bypasses the application RPC layer leaves no audit trail.
--   HIPAA requires that all access to PHI is logged at the database
--   layer, not just at the application layer.
--
-- Fix:
--   1. Central trigger function public.phi_audit_trigger() that writes
--      INSERT / UPDATE / DELETE events to audit_log for PHI tables.
--   2. Apply trigger to the seven highest-sensitivity tables:
--      patients, visits, diagnoses, patient_allergies,
--      medication_orders, lab_orders, admissions.
--   3. Make audit_log INSERT-only via explicit RLS policy:
--      no UPDATE or DELETE policy → default RLS deny applies.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- 1. Central PHI audit trigger function
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.phi_audit_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     UUID;
  v_tenant_id   UUID;
  v_facility_id UUID;
  v_old         JSONB;
  v_new         JSONB;
  v_entity_id   UUID;
  v_changed     TEXT[];
BEGIN
  -- Identify the acting user (best effort; NULL for system operations)
  SELECT id INTO v_user_id
  FROM public.users
  WHERE auth_user_id = auth.uid()
  LIMIT 1;

  -- Extract record values
  IF TG_OP = 'DELETE' THEN
    v_old       := to_jsonb(OLD);
    v_new       := NULL;
    v_entity_id := (v_old->>'id')::UUID;
    -- Prefer tenant/facility from the deleted row
    v_tenant_id   := (v_old->>'tenant_id')::UUID;
    v_facility_id := (v_old->>'facility_id')::UUID;
  ELSIF TG_OP = 'INSERT' THEN
    v_old       := NULL;
    v_new       := to_jsonb(NEW);
    v_entity_id := (v_new->>'id')::UUID;
    v_tenant_id   := (v_new->>'tenant_id')::UUID;
    v_facility_id := (v_new->>'facility_id')::UUID;
  ELSE
    -- UPDATE
    v_old       := to_jsonb(OLD);
    v_new       := to_jsonb(NEW);
    v_entity_id := (v_new->>'id')::UUID;
    v_tenant_id   := (v_new->>'tenant_id')::UUID;
    v_facility_id := (v_new->>'facility_id')::UUID;
    -- Compute list of changed fields
    SELECT array_agg(key ORDER BY key)
    INTO v_changed
    FROM jsonb_each(v_old) old_col
    WHERE v_old->old_col.key IS DISTINCT FROM v_new->old_col.key;
  END IF;

  -- Do not write audit entries for audit_log itself (prevent recursion)
  IF TG_TABLE_NAME = 'audit_log' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Skip if no tenant context (e.g., system migrations inserting seed data)
  IF v_tenant_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Strip fields that contain full PHI from the stored JSONB to avoid
  -- duplicating full record contents in audit_log (log key fields only).
  -- The changed_fields array tells reviewers what changed; old/new values
  -- are kept for the specifically relevant fields.
  IF TG_OP = 'UPDATE' AND v_changed IS NOT NULL THEN
    -- For UPDATE: only store changed field subset in new_values
    SELECT jsonb_object_agg(key, value)
    INTO v_new
    FROM jsonb_each(v_new)
    WHERE key = ANY(v_changed)
       OR key IN ('id', 'updated_at');

    SELECT jsonb_object_agg(key, value)
    INTO v_old
    FROM jsonb_each(v_old)
    WHERE key = ANY(v_changed)
       OR key IN ('id', 'updated_at');
  END IF;

  INSERT INTO public.audit_log (
    tenant_id,
    event_type,
    action,
    action_category,
    entity_type,
    entity_id,
    actor_user_id,
    facility_id,
    old_values,
    new_values,
    changed_fields,
    sensitivity_level,
    compliance_tags,
    created_at,
    created_date
  ) VALUES (
    v_tenant_id,
    TG_OP,                              -- 'INSERT', 'UPDATE', 'DELETE'
    TG_OP || ' on ' || TG_TABLE_NAME,
    'data_modification',
    TG_TABLE_NAME,
    v_entity_id,
    v_user_id,
    v_facility_id,
    v_old,
    v_new,
    v_changed,
    'phi',
    ARRAY['PHI_ACCESS', 'HIPAA'],
    now(),
    CURRENT_DATE
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- Never let audit failure block the clinical operation.
  -- Log the failure to pg_log instead.
  RAISE WARNING 'phi_audit_trigger failed on %.%: % %',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLSTATE, SQLERRM;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.phi_audit_trigger() IS
  'AFTER-ROW trigger applied to all PHI tables. '
  'Writes INSERT/UPDATE/DELETE events to audit_log with sensitivity_level=phi. '
  'Failure is non-fatal — it raises a WARNING rather than aborting the transaction.';

-- ══════════════════════════════════════════════
-- 2. Apply trigger to high-sensitivity PHI tables
-- ══════════════════════════════════════════════
-- Helper: creates the trigger on a table if it does not already exist.

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'patients',
    'visits',
    'diagnoses',
    'patient_allergies',
    'medication_orders',
    'lab_orders',
    'admissions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Only attach if table exists (safe for environments missing some tables)
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      -- Drop and recreate to pick up any function changes
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_phi_audit ON public.%I', t
      );
      EXECUTE format(
        'CREATE TRIGGER trg_phi_audit
           AFTER INSERT OR UPDATE OR DELETE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.phi_audit_trigger()',
        t
      );
      RAISE NOTICE 'Attached phi_audit_trigger to %.', t;
    ELSE
      RAISE NOTICE 'Table % not found — skipping audit trigger.', t;
    END IF;
  END LOOP;
END
$$;

-- ══════════════════════════════════════════════
-- 3. Make audit_log INSERT-only
-- ══════════════════════════════════════════════
-- Ensure no UPDATE or DELETE policy exists. The default RLS deny
-- means only INSERT (via the trigger, SECURITY DEFINER) is allowed.
-- Admins can SELECT; super_admins can SELECT all tenants.

-- Drop any accidentally-created UPDATE/DELETE policies
DROP POLICY IF EXISTS "audit_log_update" ON public.audit_log;
DROP POLICY IF EXISTS "audit_log_delete" ON public.audit_log;

-- SELECT: facility staff can read their own facility's audit log
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'audit_log'
      AND policyname = 'Facility admins can view audit log'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "Facility admins can view audit log"
        ON public.audit_log FOR SELECT
        USING (
          facility_id = public.get_user_facility_id()
          OR public.is_super_admin()
        )
    $pol$;
  END IF;
END
$$;

-- INSERT: only the trigger function (SECURITY DEFINER) inserts, so no
-- explicit INSERT policy is needed for authenticated users. Adding one
-- for the service role to cover edge cases:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'audit_log'
      AND policyname = 'System can insert audit log'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "System can insert audit log"
        ON public.audit_log FOR INSERT
        WITH CHECK (true)
    $pol$;
  END IF;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  t.tablename,
  CASE WHEN tr.tgname IS NOT NULL THEN 'YES' ELSE 'NO' END AS has_phi_audit_trigger
FROM (VALUES
  ('patients'), ('visits'), ('diagnoses'), ('patient_allergies'),
  ('medication_orders'), ('lab_orders'), ('admissions')
) AS t(tablename)
LEFT JOIN pg_trigger tr
  ON tr.tgname = 'trg_phi_audit'
  AND tr.tgrelid = (('public.' || t.tablename)::regclass)
ORDER BY t.tablename;
