-- Week 1 DB hardening: remove app-layer join-request race windows and improve audit trace queryability.

-- Normalize existing data so a pending-only unique index can be created safely.
WITH ranked_pending_requests AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY auth_user_id, facility_id
      ORDER BY requested_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS pending_rank
  FROM public.staff_registration_requests
  WHERE status = 'pending'
)
UPDATE public.staff_registration_requests req
SET
  status = 'rejected',
  reviewed_at = COALESCE(req.reviewed_at, now()),
  rejection_reason = COALESCE(
    req.rejection_reason,
    'Auto-rejected by migration: duplicate pending request superseded'
  ),
  updated_at = now()
FROM ranked_pending_requests ranked
WHERE req.id = ranked.id
  AND ranked.pending_rank > 1;

-- Enforce at-most-one pending request per (auth_user_id, facility_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_registration_requests_pending_auth_facility
ON public.staff_registration_requests (auth_user_id, facility_id)
WHERE status = 'pending';

-- Speed request-scoped audit trace lookups.
CREATE INDEX IF NOT EXISTS idx_audit_log_request_id
ON public.audit_log (request_id)
WHERE request_id IS NOT NULL;
