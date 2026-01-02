-- Drop the existing non-unique index on nurse_dashboard_queue
DROP INDEX IF EXISTS public.idx_nurse_queue_visit_id;

-- Create a UNIQUE index instead (required for concurrent refresh)
CREATE UNIQUE INDEX idx_nurse_queue_visit_id 
  ON public.nurse_dashboard_queue(visit_id);

-- Add comment explaining the purpose
COMMENT ON INDEX public.idx_nurse_queue_visit_id IS 
  'Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY operations. Each visit appears only once in the queue.';