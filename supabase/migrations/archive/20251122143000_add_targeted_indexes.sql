-- Add indexes to support high-traffic clinical queries

-- Optimize doctor worklists by filtering on facility, doctor, and active status
CREATE INDEX IF NOT EXISTS visits_active_doctor_created_at_idx
  ON public.visits (facility_id, assigned_doctor, created_at DESC)
  WHERE status NOT IN ('discharged', 'cancelled');

-- Accelerate inpatient dashboards for admitted patients
CREATE INDEX IF NOT EXISTS visits_admitted_doctor_admitted_at_idx
  ON public.visits (assigned_doctor, admitted_at DESC)
  WHERE status = 'admitted'
    AND admission_ward IS NOT NULL
    AND admission_bed IS NOT NULL;

-- Speed up retrieval of completed lab results for provider queues
CREATE INDEX IF NOT EXISTS lab_orders_completed_visit_idx
  ON public.lab_orders (visit_id, completed_at DESC)
  WHERE status = 'completed'
    AND completed_at IS NOT NULL;

-- Speed up retrieval of completed imaging results for provider queues
CREATE INDEX IF NOT EXISTS imaging_orders_completed_visit_idx
  ON public.imaging_orders (visit_id, completed_at DESC)
  WHERE status = 'completed'
    AND completed_at IS NOT NULL;

-- Support inpatient task backlogs filtered by visit and status
CREATE INDEX IF NOT EXISTS medication_orders_pending_visit_idx
  ON public.medication_orders (visit_id)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS lab_orders_pending_visit_idx
  ON public.lab_orders (visit_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS imaging_orders_pending_visit_idx
  ON public.imaging_orders (visit_id)
  WHERE status = 'pending';
