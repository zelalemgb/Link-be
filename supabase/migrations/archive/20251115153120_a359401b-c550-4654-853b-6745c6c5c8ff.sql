-- Create performance index for doctor patient queue filtering
-- This index supports facility_id, assigned_doctor, status filtering, and created_at sorting
CREATE INDEX IF NOT EXISTS visits_active_doctor_queue_idx 
ON public.visits (facility_id, assigned_doctor, status, created_at DESC)
WHERE status NOT IN ('discharged', 'cancelled');

-- Create index for results-ready patient lookups
CREATE INDEX IF NOT EXISTS lab_orders_completed_patient_idx
ON public.lab_orders (patient_id, status, completed_at DESC)
WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS imaging_orders_completed_patient_idx
ON public.imaging_orders (patient_id, status, completed_at DESC)
WHERE status = 'completed';