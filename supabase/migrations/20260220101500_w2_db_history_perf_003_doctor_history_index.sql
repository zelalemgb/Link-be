-- W2-DB-HISTORY-PERF-003
-- Doctor history read path optimization:
--   GET /api/patients/:id/visits/history
-- Query shape:
--   WHERE tenant_id = ? AND facility_id = ? AND patient_id = ?
--   ORDER BY visit_date DESC
--   LIMIT ?
--
-- Existing indexes cover patient/date and tenant/facility independently.
-- This composite index avoids extra filtered index walking for facility-scoped history reads.

CREATE INDEX IF NOT EXISTS idx_visits_tenant_facility_patient_date_desc
  ON public.visits (tenant_id, facility_id, patient_id, visit_date DESC)
  WHERE facility_id IS NOT NULL;

COMMENT ON INDEX public.idx_visits_tenant_facility_patient_date_desc IS
  'Optimizes facility-scoped patient visit history reads used by doctor history flows.';

