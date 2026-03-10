-- Re-assert audit_log sensitivity-level constraint for PHI events.
-- Staging observed audit inserts failing with:
--   audit_log_sensitivity_level_check
-- when backend writes sensitivity_level='phi'.

BEGIN;

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.audit_log'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%sensitivity_level%'
  LOOP
    EXECUTE format('ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS %I', rec.conname);
  END LOOP;
END
$$;

ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_sensitivity_level_check
  CHECK (
    sensitivity_level IS NULL
    OR lower(sensitivity_level) IN ('low', 'medium', 'high', 'critical', 'phi')
  );

COMMIT;
