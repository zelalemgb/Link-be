-- ============================================================
-- FIX 26: SaaS Subscriptions, Trials, Licensing & Agent Network
-- ============================================================
-- Enables:
--   • Self-service 30-day trial on registration
--   • Subscription tiers with automatic trial enforcement
--   • Cryptographic offline license keys for hub-based clinics
--   • Agent portal for rural/offline payment collection
--   • Payment event logging (Chapa + Stripe webhooks)
--   • Trial reminder tracking (no duplicate emails)
--   • Hub registration and sync state
-- ============================================================

-- ── 1. Extend tenants with subscription state ──────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS subscription_status  TEXT    NOT NULL DEFAULT 'trial'
    CHECK (subscription_status IN ('trial','grace','active','restricted','suspended','cancelled')),
  ADD COLUMN IF NOT EXISTS subscription_tier    TEXT    NOT NULL DEFAULT 'health_centre'
    CHECK (subscription_tier IN ('health_post','health_centre','primary_hospital','general_hospital','enterprise')),
  ADD COLUMN IF NOT EXISTS trial_started_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_expires_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grace_expires_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_phone        TEXT,
  ADD COLUMN IF NOT EXISTS contact_email        TEXT,
  ADD COLUMN IF NOT EXISTS billing_currency     TEXT    NOT NULL DEFAULT 'ETB'
    CHECK (billing_currency IN ('ETB','USD','EUR')),
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_step      INTEGER NOT NULL DEFAULT 0;

-- Backfill existing tenants (already active)
UPDATE public.tenants
SET
  subscription_status   = 'active',
  trial_started_at      = created_at,
  trial_expires_at      = created_at + INTERVAL '30 days',
  subscription_expires_at = now() + INTERVAL '1 year',
  onboarding_completed  = TRUE,
  onboarding_step       = 5
WHERE subscription_status = 'trial'
  AND created_at < now() - INTERVAL '30 days';

-- ── 2. subscription_plans ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tier            TEXT        NOT NULL UNIQUE
    CHECK (tier IN ('health_post','health_centre','primary_hospital','general_hospital','enterprise')),
  display_name    TEXT        NOT NULL,
  price_etb       NUMERIC(10,2) NOT NULL,
  price_usd       NUMERIC(10,2) NOT NULL,
  max_users       INTEGER,
  max_facilities  INTEGER     NOT NULL DEFAULT 1,
  features        JSONB       NOT NULL DEFAULT '{}',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.subscription_plans (tier, display_name, price_etb, price_usd, max_users, max_facilities, features) VALUES
  ('health_post',        'Health Post',         500,   9,   10, 1,  '{"cdss":true,"ai_advisor":false,"lab":false,"pharmacy":true,"reports":true}'::JSONB),
  ('health_centre',      'Health Centre',       1500,  25,  30, 1,  '{"cdss":true,"ai_advisor":true,"lab":true,"pharmacy":true,"reports":true,"nhia":true}'::JSONB),
  ('primary_hospital',   'Primary Hospital',    4000,  65,  100,3,  '{"cdss":true,"ai_advisor":true,"lab":true,"pharmacy":true,"reports":true,"nhia":true,"imaging":true}'::JSONB),
  ('general_hospital',   'General Hospital',    9000,  145, 250,10, '{"cdss":true,"ai_advisor":true,"lab":true,"pharmacy":true,"reports":true,"nhia":true,"imaging":true,"api_access":true}'::JSONB),
  ('enterprise',         'Enterprise / NGO',    0,     0,   null,null,'{"cdss":true,"ai_advisor":true,"lab":true,"pharmacy":true,"reports":true,"nhia":true,"imaging":true,"api_access":true,"custom_branding":true}'::JSONB)
ON CONFLICT (tier) DO NOTHING;

-- ── 3. payment_events ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payment_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  hub_id            UUID,       -- NULL for cloud-only tenants

  -- Payment gateway
  gateway           TEXT        NOT NULL
    CHECK (gateway IN ('chapa','stripe','telebirr_manual','bank_transfer','agent_cash','government_procurement','free')),
  gateway_tx_id     TEXT,       -- transaction ID from gateway
  gateway_reference TEXT,       -- short reference for SMS confirmation

  -- Amount
  amount            NUMERIC(12,2) NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'ETB',

  -- What was purchased
  plan_tier         TEXT        NOT NULL,
  period_months     INTEGER     NOT NULL DEFAULT 1,
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,

  -- State
  status            TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','failed','refunded')),
  confirmed_at      TIMESTAMPTZ,
  confirmed_by      UUID        REFERENCES public.users(id),  -- for manual/agent payments
  notes             TEXT,

  -- Audit
  row_version       BIGINT      NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pe_tenant    ON public.payment_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_pe_status    ON public.payment_events (status);
CREATE INDEX IF NOT EXISTS idx_pe_gateway   ON public.payment_events (gateway, gateway_tx_id);

-- ── 4. license_keys ───────────────────────────────────────────────────────
-- JWT-based offline license keys. Validated locally by hub using embedded
-- RSA public key — no internet required.

CREATE TABLE IF NOT EXISTS public.license_keys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  hub_id          UUID        NOT NULL,  -- references hub_registrations.id

  -- The signed JWT license token
  license_jwt     TEXT        NOT NULL,

  -- Short human-readable activation code (for SMS/phone delivery)
  -- Format: LNKH-XXXX-XXXX-XXXX  (16 uppercase alphanumeric chars)
  activation_code TEXT        NOT NULL UNIQUE,

  -- License validity
  tier            TEXT        NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  is_revoked      BOOLEAN     NOT NULL DEFAULT FALSE,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,

  -- Link back to the payment that generated this license
  payment_event_id UUID       REFERENCES public.payment_events(id),

  -- Delivery tracking
  delivered_via   TEXT        CHECK (delivered_via IN ('sms','whatsapp','email','agent','qr_code','portal')),
  delivered_at    TIMESTAMPTZ,

  -- How many times the hub has activated this key
  activation_count INTEGER    NOT NULL DEFAULT 0,
  last_activated_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lk_hub         ON public.license_keys (hub_id);
CREATE INDEX IF NOT EXISTS idx_lk_tenant      ON public.license_keys (tenant_id);
CREATE INDEX IF NOT EXISTS idx_lk_activation  ON public.license_keys (activation_code);
CREATE INDEX IF NOT EXISTS idx_lk_active      ON public.license_keys (hub_id, is_revoked, expires_at);

-- ── 5. hub_registrations ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.hub_registrations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id     UUID        REFERENCES public.facilities(id),

  -- Cryptographic fingerprint generated on hub install
  -- HMAC-SHA256(MAC_address || hostname || install_timestamp)
  hub_fingerprint TEXT        NOT NULL UNIQUE,

  -- Network info (optional, set on first cloud contact)
  local_ip        TEXT,
  hub_version     TEXT,
  os_platform     TEXT,

  -- Sync state
  last_sync_at         TIMESTAMPTZ,
  last_sync_direction  TEXT  CHECK (last_sync_direction IN ('push','pull','bidirectional')),
  sync_error_count     INTEGER NOT NULL DEFAULT 0,
  last_sync_error      TEXT,
  total_syncs          BIGINT  NOT NULL DEFAULT 0,
  rows_pushed          BIGINT  NOT NULL DEFAULT 0,
  rows_pulled          BIGINT  NOT NULL DEFAULT 0,

  -- Status
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_tenant      ON public.hub_registrations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_hr_fingerprint ON public.hub_registrations (hub_fingerprint);

-- ── 6. trial_reminder_logs ────────────────────────────────────────────────
-- Prevents duplicate reminder emails

CREATE TABLE IF NOT EXISTS public.trial_reminder_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  reminder_type   TEXT        NOT NULL
    CHECK (reminder_type IN ('day7','day14','day21','day25','day29','expired','grace_warning','final_warning')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_to         TEXT        NOT NULL,  -- email/phone
  channel         TEXT        NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms','whatsapp')),
  UNIQUE (tenant_id, reminder_type)     -- one of each type per tenant
);

CREATE INDEX IF NOT EXISTS idx_trl_tenant ON public.trial_reminder_logs (tenant_id);

-- ── 7. agents ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agents (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT        NOT NULL,
  phone           TEXT        NOT NULL UNIQUE,
  email           TEXT,
  region          TEXT        NOT NULL,   -- e.g. "Oromia", "Amhara", "SNNPR"
  zone            TEXT,
  woreda          TEXT,
  status          TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','terminated')),
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 15.00,  -- percentage
  user_id         UUID        REFERENCES public.users(id),  -- agent portal login
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_assignments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID        NOT NULL REFERENCES public.agents(id),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS public.agent_commissions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID        NOT NULL REFERENCES public.agents(id),
  payment_event_id UUID       NOT NULL REFERENCES public.payment_events(id),
  amount          NUMERIC(10,2) NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'ETB',
  status          TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','cancelled')),
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aa_agent  ON public.agent_assignments (agent_id);
CREATE INDEX IF NOT EXISTS idx_aa_tenant ON public.agent_assignments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ac_agent  ON public.agent_commissions (agent_id, status);

-- ── 8. onboarding_checklist ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.onboarding_checklist (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE UNIQUE,
  step_add_facility       BOOLEAN NOT NULL DEFAULT FALSE,
  step_add_users          BOOLEAN NOT NULL DEFAULT FALSE,
  step_configure_services BOOLEAN NOT NULL DEFAULT FALSE,
  step_run_test_patient   BOOLEAN NOT NULL DEFAULT FALSE,
  step_configure_billing  BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 9. Row-version triggers ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bump_payment_row_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_at  := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pe_rv ON public.payment_events;
CREATE TRIGGER trg_pe_rv
  BEFORE UPDATE ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public.bump_payment_row_version();

-- ── 10. RLS ───────────────────────────────────────────────────────────────

ALTER TABLE public.payment_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.license_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hub_registrations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_reminder_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_checklist   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_assignments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_commissions      ENABLE ROW LEVEL SECURITY;

-- Tenant-scoped access
DROP POLICY IF EXISTS "tenant_iso_payment_events" ON public.payment_events;
DROP POLICY IF EXISTS "tenant_iso_license_keys" ON public.license_keys;
DROP POLICY IF EXISTS "tenant_iso_hub_registrations" ON public.hub_registrations;
DROP POLICY IF EXISTS "tenant_iso_trial_reminders" ON public.trial_reminder_logs;
DROP POLICY IF EXISTS "tenant_iso_onboarding" ON public.onboarding_checklist;
CREATE POLICY "tenant_iso_payment_events"     ON public.payment_events     USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1));
CREATE POLICY "tenant_iso_license_keys"       ON public.license_keys       USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1));
CREATE POLICY "tenant_iso_hub_registrations"  ON public.hub_registrations  USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1));
CREATE POLICY "tenant_iso_trial_reminders"    ON public.trial_reminder_logs USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1));
CREATE POLICY "tenant_iso_onboarding"         ON public.onboarding_checklist USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid() LIMIT 1));

-- Agent access: agents only see their own records
DROP POLICY IF EXISTS "agent_self_access" ON public.agents;
DROP POLICY IF EXISTS "agent_assignment_access" ON public.agent_assignments;
DROP POLICY IF EXISTS "agent_commission_access" ON public.agent_commissions;
CREATE POLICY "agent_self_access" ON public.agents USING (user_id = auth.uid());
CREATE POLICY "agent_assignment_access" ON public.agent_assignments USING (agent_id = (SELECT id FROM public.agents WHERE user_id = auth.uid() LIMIT 1));
CREATE POLICY "agent_commission_access" ON public.agent_commissions USING (agent_id = (SELECT id FROM public.agents WHERE user_id = auth.uid() LIMIT 1));

-- ── 11. Helper function: compute effective subscription status ────────────

CREATE OR REPLACE FUNCTION public.get_tenant_access_level(p_tenant_id UUID)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_status TEXT;
  v_trial_exp TIMESTAMPTZ;
  v_sub_exp   TIMESTAMPTZ;
  v_grace_exp TIMESTAMPTZ;
BEGIN
  SELECT subscription_status, trial_expires_at, subscription_expires_at, grace_expires_at
  INTO v_status, v_trial_exp, v_sub_exp, v_grace_exp
  FROM public.tenants WHERE id = p_tenant_id;

  -- Already marked active and subscription not expired
  IF v_status = 'active' AND (v_sub_exp IS NULL OR v_sub_exp > now()) THEN
    RETURN 'full';
  END IF;

  -- Trial still running
  IF v_status = 'trial' AND v_trial_exp IS NOT NULL AND v_trial_exp > now() THEN
    RETURN 'full';
  END IF;

  -- Grace period
  IF v_status = 'grace' AND v_grace_exp IS NOT NULL AND v_grace_exp > now() THEN
    RETURN 'grace';
  END IF;

  -- Restricted / expired
  IF v_status IN ('restricted','suspended','cancelled') THEN
    RETURN 'read_only';
  END IF;

  -- Trial expired but not yet updated
  IF v_trial_exp IS NOT NULL AND v_trial_exp < now() AND v_status = 'trial' THEN
    RETURN 'read_only';
  END IF;

  RETURN 'read_only';
END;
$$;

-- ── 12. Comments ──────────────────────────────────────────────────────────

COMMENT ON TABLE public.subscription_plans  IS 'Pricing tiers for Link HC SaaS subscriptions.';
COMMENT ON TABLE public.payment_events      IS 'All payment transactions (cloud and offline/agent). Source of truth for billing.';
COMMENT ON TABLE public.license_keys        IS 'Cryptographic JWT license keys for offline hub operation. Validated locally without internet.';
COMMENT ON TABLE public.hub_registrations   IS 'Local hub installations at clinic sites. Tracks sync state and connectivity.';
COMMENT ON TABLE public.trial_reminder_logs IS 'Prevents duplicate trial expiry reminder emails/SMS.';
COMMENT ON TABLE public.agents              IS 'Regional agents who collect payments and deliver activation codes to offline clinics.';
