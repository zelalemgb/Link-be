-- Allow deprioritized status for feature requests managed by super admins
ALTER TABLE public.feature_requests
  DROP CONSTRAINT IF EXISTS feature_requests_status_check;

ALTER TABLE public.feature_requests
  ADD CONSTRAINT feature_requests_status_check
  CHECK (status IN (
    'submitted',
    'under_review',
    'approved',
    'implemented',
    'deprioritized',
    'rejected'
  ));
