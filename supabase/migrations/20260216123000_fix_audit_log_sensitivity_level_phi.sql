-- Align audit_log.sensitivity_level with backend usage.
-- Backend emits sensitivityLevel='phi' for PHI events; the init schema constraint
-- only allowed ('low','medium','high','critical'), causing inserts to fail.

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_sensitivity_level_check;

ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_sensitivity_level_check
  CHECK (sensitivity_level IN ('low', 'medium', 'high', 'critical', 'phi'));

