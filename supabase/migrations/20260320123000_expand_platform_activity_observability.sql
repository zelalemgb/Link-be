ALTER TABLE public.platform_activity_log
  ADD COLUMN IF NOT EXISTS frontend_release_sha text NULL,
  ADD COLUMN IF NOT EXISTS backend_release_sha text NULL,
  ADD COLUMN IF NOT EXISTS frontend_asset_bundle text NULL,
  ADD COLUMN IF NOT EXISTS service_worker_state text NULL,
  ADD COLUMN IF NOT EXISTS service_worker_script_url text NULL,
  ADD COLUMN IF NOT EXISTS network_online boolean NULL,
  ADD COLUMN IF NOT EXISTS network_effective_type text NULL,
  ADD COLUMN IF NOT EXISTS auth_bootstrap_phase text NULL,
  ADD COLUMN IF NOT EXISTS scope_source text NULL,
  ADD COLUMN IF NOT EXISTS request_id uuid NULL,
  ADD COLUMN IF NOT EXISTS error_fingerprint text NULL,
  ADD COLUMN IF NOT EXISTS failure_kind text NULL,
  ADD COLUMN IF NOT EXISTS server_decision_reason text NULL,
  ADD COLUMN IF NOT EXISTS route_from text NULL,
  ADD COLUMN IF NOT EXISTS active_facility_id uuid NULL REFERENCES public.facilities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS failing_chunk_url text NULL,
  ADD COLUMN IF NOT EXISTS boundary_name text NULL,
  ADD COLUMN IF NOT EXISTS component_stack text NULL;

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_failure_kind
  ON public.platform_activity_log (failure_kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_error_fingerprint
  ON public.platform_activity_log (error_fingerprint, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_frontend_release
  ON public.platform_activity_log (frontend_release_sha, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_backend_release
  ON public.platform_activity_log (backend_release_sha, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_request_id
  ON public.platform_activity_log (request_id);
