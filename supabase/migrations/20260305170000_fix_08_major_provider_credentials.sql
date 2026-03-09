-- ============================================================
-- FIX 08 — MAJOR: Provider Credentials Table
-- ============================================================
-- Problem:
--   There is no table tracking professional credentials for clinical
--   staff (medical license numbers, registration boards, expiry dates).
--   This means:
--     • No enforcement of credential validity before allowing orders
--     • No alerts for expiring licenses
--     • Non-compliant with healthcare facility accreditation (JCI, NHIA)
--     • Prescriptions and orders can't be attributed to a licensed
--       provider in external reporting
-- Fix:
--   Create public.provider_credentials with full credential lifecycle
--   tracking and RLS, plus a helper view for active credentials.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────
-- 1. provider_credentials table
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.provider_credentials (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant / Facility scope
  tenant_id             UUID NOT NULL REFERENCES public.tenants(id),
  facility_id           UUID NOT NULL REFERENCES public.facilities(id),

  -- Provider (user record)
  user_id               UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,

  -- Credential classification
  credential_type       TEXT NOT NULL
    CHECK (credential_type IN (
      'medical_license',          -- General medical license
      'specialist_certificate',   -- Specialty board certificate
      'nursing_license',          -- Nursing council registration
      'pharmacy_license',         -- Pharmacy council registration
      'lab_technician_license',   -- Lab technician registration
      'clinical_officer_license', -- Clinical officer license
      'hew_certificate',          -- Health extension worker certificate
      'cpe_certificate',          -- Continuing professional education
      'bls_certification',        -- Basic life support
      'acls_certification',       -- Advanced cardiac life support
      'other'
    )),

  -- Credential details
  credential_number     TEXT NOT NULL,          -- License/registration number
  issuing_authority     TEXT NOT NULL,          -- e.g. "Ethiopian Medical Council"
  issuing_country       TEXT NOT NULL DEFAULT 'ET',  -- ISO 3166-1 alpha-2

  -- Validity dates
  issue_date            DATE NOT NULL,
  expiry_date           DATE,                   -- NULL = does not expire

  -- Status lifecycle
  status                TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN (
      'active',
      'expired',
      'suspended',
      'revoked',
      'pending_renewal',
      'pending_verification'
    )),

  -- Verification tracking
  verification_status   TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN (
      'unverified',      -- uploaded by user, not yet checked
      'verified',        -- checked against issuing authority
      'failed',          -- verification failed
      'not_required'     -- waived
    )),
  verified_by           UUID REFERENCES public.users(id),
  verified_at           TIMESTAMPTZ,

  -- Document storage (path in Supabase Storage or external URL)
  document_url          TEXT,
  document_storage_path TEXT,

  -- Renewal tracking
  renewal_reminder_sent_at  TIMESTAMPTZ,
  renewal_submitted_at      TIMESTAMPTZ,

  -- Notes
  notes                 TEXT,

  -- Audit
  created_by            UUID NOT NULL REFERENCES public.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ   -- soft-delete

  -- Unique: one credential number per issuing authority per user
  -- (a user can hold the same credential number from multiple authorities,
  --  but not two of the same from the same authority)
);

-- Add unique constraint separately for clarity
ALTER TABLE public.provider_credentials
  ADD CONSTRAINT uq_provider_credential
  UNIQUE (user_id, credential_type, credential_number, issuing_authority);

-- ──────────────────────────────────────────────
-- 2. Indexes
-- ──────────────────────────────────────────────

-- Primary: all credentials for a provider
CREATE INDEX IF NOT EXISTS idx_pc_user_id
  ON public.provider_credentials(user_id)
  WHERE deleted_at IS NULL;

-- Facility-level credential audit
CREATE INDEX IF NOT EXISTS idx_pc_facility_type_status
  ON public.provider_credentials(facility_id, credential_type, status)
  WHERE deleted_at IS NULL;

-- Expiry alerts: credentials expiring within 90 days
CREATE INDEX IF NOT EXISTS idx_pc_expiry_date
  ON public.provider_credentials(facility_id, expiry_date)
  WHERE status = 'active' AND expiry_date IS NOT NULL;

-- ──────────────────────────────────────────────
-- 3. Auto-expire credentials past their expiry date
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_expire_credentials()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.expiry_date IS NOT NULL
    AND NEW.expiry_date < CURRENT_DATE
    AND NEW.status = 'active'
  THEN
    NEW.status := 'expired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_expire_credentials
  BEFORE INSERT OR UPDATE ON public.provider_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_expire_credentials();

-- updated_at trigger
CREATE TRIGGER update_provider_credentials_updated_at
  BEFORE UPDATE ON public.provider_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ──────────────────────────────────────────────
-- 4. Enable RLS
-- ──────────────────────────────────────────────
ALTER TABLE public.provider_credentials ENABLE ROW LEVEL SECURITY;

-- Any facility staff can view credentials (transparency)
CREATE POLICY "Facility staff can view provider credentials"
  ON public.provider_credentials FOR SELECT
  USING (
    facility_id = public.get_user_facility_id()
    AND deleted_at IS NULL
  );

-- Providers can see their own credentials from any facility
CREATE POLICY "Providers can view their own credentials"
  ON public.provider_credentials FOR SELECT
  USING (
    user_id IN (
      SELECT id FROM public.users WHERE auth_user_id = auth.uid()
    )
    AND deleted_at IS NULL
  );

-- Only admins and the provider themselves can insert
CREATE POLICY "Admin or provider can add credentials"
  ON public.provider_credentials FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND (
      public.is_admin_or_super()
      OR user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
    )
  );

-- Only admins can verify / update status
CREATE POLICY "Admin can update provider credentials"
  ON public.provider_credentials FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND public.is_admin_or_super()
  );

-- ──────────────────────────────────────────────
-- 5. Convenience view: active credentials per provider
-- ──────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_active_provider_credentials AS
SELECT
  pc.id,
  pc.facility_id,
  pc.user_id,
  u.full_name       AS provider_name,
  u.user_role       AS provider_role,
  pc.credential_type,
  pc.credential_number,
  pc.issuing_authority,
  pc.issue_date,
  pc.expiry_date,
  pc.status,
  pc.verification_status,
  -- Days until expiry
  CASE
    WHEN pc.expiry_date IS NULL THEN NULL
    ELSE (pc.expiry_date - CURRENT_DATE)
  END               AS days_until_expiry,
  -- Expiry warning flag
  CASE
    WHEN pc.expiry_date IS NULL THEN FALSE
    WHEN pc.expiry_date <= CURRENT_DATE THEN TRUE
    WHEN pc.expiry_date <= CURRENT_DATE + INTERVAL '90 days' THEN TRUE
    ELSE FALSE
  END               AS expiry_warning
FROM public.provider_credentials pc
JOIN public.users u ON u.id = pc.user_id
WHERE pc.status IN ('active', 'pending_renewal')
  AND pc.deleted_at IS NULL;

COMMENT ON VIEW public.v_active_provider_credentials IS
  'Active and pending-renewal credentials with expiry warning flags. '
  'Use for dashboard alerts and order validation.';

-- ──────────────────────────────────────────────
-- 6. Helper function: check if a user has a valid clinical credential
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_valid_credential(
  p_user_id UUID,
  p_credential_type TEXT DEFAULT 'medical_license'
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.provider_credentials pc
    WHERE pc.user_id        = p_user_id
      AND pc.credential_type = p_credential_type
      AND pc.status          = 'active'
      AND pc.deleted_at      IS NULL
      AND (pc.expiry_date IS NULL OR pc.expiry_date >= CURRENT_DATE)
  );
$$;

COMMENT ON FUNCTION public.has_valid_credential(UUID, TEXT) IS
  'Returns TRUE if the given user has an active, non-expired credential '
  'of the specified type. Defaults to medical_license check.';

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'provider_credentials'
ORDER BY ordinal_position;
