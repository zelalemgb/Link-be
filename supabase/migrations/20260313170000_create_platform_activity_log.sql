CREATE TABLE IF NOT EXISTS public.platform_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'web',
  category text NOT NULL CHECK (category IN ('session', 'navigation', 'auth', 'registration', 'action', 'api', 'error')),
  event_name text NOT NULL,
  outcome text NULL CHECK (outcome IN ('started', 'success', 'failure', 'info')),
  actor_user_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  actor_auth_user_id uuid NULL,
  actor_role text NULL,
  actor_email text NULL,
  tenant_id uuid NULL REFERENCES public.tenants(id) ON DELETE SET NULL,
  facility_id uuid NULL REFERENCES public.facilities(id) ON DELETE SET NULL,
  page_path text NULL,
  page_title text NULL,
  entry_point text NULL,
  request_path text NULL,
  request_method text NULL,
  response_status integer NULL,
  duration_ms integer NULL,
  error_message text NULL,
  ip_address inet NULL,
  user_agent text NULL,
  referrer text NULL,
  timezone text NULL,
  locale text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_occurred_at
  ON public.platform_activity_log (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_session
  ON public.platform_activity_log (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_actor
  ON public.platform_activity_log (actor_user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_scope
  ON public.platform_activity_log (tenant_id, facility_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_activity_log_category_event
  ON public.platform_activity_log (category, event_name, occurred_at DESC);

ALTER TABLE public.platform_activity_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'platform_activity_log'
      AND policyname = 'Super admins can access platform activity log'
  ) THEN
    CREATE POLICY "Super admins can access platform activity log"
      ON public.platform_activity_log
      FOR SELECT
      TO authenticated
      USING (public.is_super_admin());
  END IF;
END $$;
