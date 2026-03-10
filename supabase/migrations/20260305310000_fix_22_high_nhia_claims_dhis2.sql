-- ============================================================
-- FIX 22 — HIGH: NHIA Claims, Benefit Exhaustion,
--                Pre-Authorization, DHIS2 Scaffolding,
--                Fee Exemptions, Program Classification
-- ============================================================
-- Resolves gaps: N-1, N-2, N-3, N-4, N-5, N-6, D-1, D-2, D-3, D-4
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- 1. Program type classification (N-6)
-- ══════════════════════════════════════════════
ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS program_type TEXT
    CHECK (program_type IN (
      'cbhi',          -- Community-Based Health Insurance
      'staff_scheme',  -- Government/employer staff health scheme
      'private',       -- Private insurance
      'fee_waiver',    -- Fee waiver (NGO-funded, donor-covered)
      'exemption',     -- Government exemption (under-5, maternal, elderly)
      'social',        -- Social health insurance
      'other'
    )),
  ADD COLUMN IF NOT EXISTS is_nhia_programme BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS formulary_code     TEXT,  -- NHIA formulary/benefit package code
  ADD COLUMN IF NOT EXISTS description        TEXT;

COMMENT ON COLUMN public.programs.program_type IS
  'Classifies the insurance/coverage programme type. '
  'Required for NHIA reporting and claim routing.';
COMMENT ON COLUMN public.programs.is_nhia_programme IS
  'TRUE if this programme is regulated/reimbursed by NHIA Ethiopia.';

-- ══════════════════════════════════════════════
-- 2. NHIA claims submission table (N-4)
--    Tracks per-visit claims submitted to NHIA for reimbursement
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.nhia_claims (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  tenant_id            UUID NOT NULL REFERENCES public.tenants(id)    ON DELETE RESTRICT,
  facility_id          UUID NOT NULL REFERENCES public.facilities(id)  ON DELETE RESTRICT,

  -- Claim source
  visit_id             UUID REFERENCES public.visits(id)               ON DELETE SET NULL,
  patient_id           UUID NOT NULL REFERENCES public.patients(id)    ON DELETE RESTRICT,
  patient_insurance_id UUID REFERENCES public.patient_insurance(id)    ON DELETE SET NULL,

  -- Claim identity
  claim_number         TEXT UNIQUE,         -- NHIA-assigned claim reference
  internal_ref         TEXT,                -- Internal facility claim tracking number

  -- Financial
  claim_date           DATE NOT NULL DEFAULT CURRENT_DATE,
  service_from_date    DATE,
  service_to_date      DATE,
  total_billed_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  nhia_covered_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  patient_copay_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  adjustment_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,  -- denials / partial approvals
  net_payable_amount   NUMERIC(12,2)
    GENERATED ALWAYS AS (nhia_covered_amount + adjustment_amount) STORED,

  -- Submission workflow
  status               TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',          -- being prepared
      'submitted',      -- sent to NHIA portal
      'acknowledged',   -- NHIA received and acknowledged
      'in_review',      -- NHIA reviewing
      'approved',       -- fully approved
      'partially_approved', -- approved with deductions
      'rejected',       -- denied
      'appealed',       -- rejection appealed
      'paid',           -- NHIA transferred funds
      'cancelled'
    )),

  submitted_at         TIMESTAMPTZ,
  submitted_by         UUID REFERENCES public.users(id),
  adjudicated_at       TIMESTAMPTZ,
  paid_at              TIMESTAMPTZ,
  payment_reference    TEXT,         -- bank transfer / cheque reference

  -- Rejection handling
  rejection_code       TEXT,
  rejection_reason     TEXT,
  appeal_submitted_at  TIMESTAMPTZ,
  appeal_reason        TEXT,

  -- Diagnosis codes attached to claim (ICD-10)
  diagnosis_codes      TEXT[],       -- array of ICD-10 codes billed

  -- Audit
  notes                TEXT,
  created_by           UUID REFERENCES public.users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Wave 2 sync
  row_version          BIGINT NOT NULL DEFAULT 1,

  CONSTRAINT chk_claim_amounts_non_negative
    CHECK (total_billed_amount >= 0
      AND nhia_covered_amount >= 0
      AND patient_copay_amount >= 0),
  CONSTRAINT chk_claim_covered_not_exceed_billed
    CHECK (nhia_covered_amount <= total_billed_amount)
);

CREATE INDEX IF NOT EXISTS idx_nhia_claims_patient
  ON public.nhia_claims(patient_id, claim_date DESC);
CREATE INDEX IF NOT EXISTS idx_nhia_claims_facility_status
  ON public.nhia_claims(facility_id, status, claim_date DESC);
CREATE INDEX IF NOT EXISTS idx_nhia_claims_status_pending
  ON public.nhia_claims(status, submitted_at ASC)
  WHERE status IN ('submitted','acknowledged','in_review','appealed');

CREATE TRIGGER update_nhia_claims_updated_at
  BEFORE UPDATE ON public.nhia_claims
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_nhia_claims_row_version ON public.nhia_claims;
CREATE TRIGGER trg_nhia_claims_row_version
  BEFORE UPDATE ON public.nhia_claims
  FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

-- RLS
ALTER TABLE public.nhia_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff can view NHIA claims"
  ON public.nhia_claims FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "Finance staff can manage NHIA claims"
  ON public.nhia_claims FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin','accountant','super_admin')
    )
  );

CREATE POLICY "Finance staff can update NHIA claims"
  ON public.nhia_claims FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin','accountant','super_admin')
    )
  );

COMMENT ON TABLE public.nhia_claims IS
  'NHIA Ethiopia claim submission and adjudication tracking. '
  'One row per claim (typically one per visit). '
  'Links patient_insurance enrollment to billed services.';

-- ══════════════════════════════════════════════
-- 3. Insurance benefit usage / exhaustion tracking (N-1)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.insurance_benefit_usage (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id            UUID NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  patient_insurance_id UUID NOT NULL REFERENCES public.patient_insurance(id) ON DELETE CASCADE,
  patient_id           UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  -- Period (typically calendar year or policy year)
  benefit_period_start DATE NOT NULL,
  benefit_period_end   DATE NOT NULL,

  -- Usage counters
  amount_used          NUMERIC(12,2) NOT NULL DEFAULT 0,
  claims_count         INTEGER NOT NULL DEFAULT 0,
  last_claim_date      DATE,
  last_updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_benefit_usage_period
    UNIQUE (patient_insurance_id, benefit_period_start),
  CONSTRAINT chk_benefit_period_valid
    CHECK (benefit_period_end >= benefit_period_start),
  CONSTRAINT chk_benefit_amount_non_negative
    CHECK (amount_used >= 0)
);

CREATE INDEX IF NOT EXISTS idx_benefit_usage_patient
  ON public.insurance_benefit_usage(patient_id, benefit_period_start DESC);
CREATE INDEX IF NOT EXISTS idx_benefit_usage_insurance
  ON public.insurance_benefit_usage(patient_insurance_id, benefit_period_start DESC);

COMMENT ON TABLE public.insurance_benefit_usage IS
  'Tracks cumulative insurance benefit consumption per patient per policy year. '
  'Updated by trigger when an nhia_claim transitions to approved/paid. '
  'Used by get_active_patient_insurance() to check annual_limit exhaustion.';

-- Trigger: update benefit usage when an NHIA claim is approved or paid
CREATE OR REPLACE FUNCTION public.update_benefit_usage_on_claim()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy_year_start DATE;
  v_policy_year_end   DATE;
  v_amount            NUMERIC;
BEGIN
  -- Only act when status changes to approved/partially_approved/paid
  IF NEW.status NOT IN ('approved','partially_approved','paid') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;  -- no change
  END IF;
  IF NEW.patient_insurance_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_amount := COALESCE(NEW.nhia_covered_amount, 0);
  IF v_amount = 0 THEN RETURN NEW; END IF;

  -- Determine the benefit period (calendar year of claim_date)
  v_policy_year_start := DATE_TRUNC('year', NEW.claim_date)::DATE;
  v_policy_year_end   := (DATE_TRUNC('year', NEW.claim_date) + INTERVAL '1 year - 1 day')::DATE;

  INSERT INTO public.insurance_benefit_usage (
    tenant_id, patient_insurance_id, patient_id,
    benefit_period_start, benefit_period_end,
    amount_used, claims_count, last_claim_date, last_updated_at
  )
  VALUES (
    NEW.tenant_id, NEW.patient_insurance_id, NEW.patient_id,
    v_policy_year_start, v_policy_year_end,
    v_amount, 1, NEW.claim_date, now()
  )
  ON CONFLICT (patient_insurance_id, benefit_period_start)
  DO UPDATE SET
    amount_used     = insurance_benefit_usage.amount_used + EXCLUDED.amount_used,
    claims_count    = insurance_benefit_usage.claims_count + 1,
    last_claim_date = GREATEST(insurance_benefit_usage.last_claim_date, EXCLUDED.last_claim_date),
    last_updated_at = now();

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'update_benefit_usage_on_claim failed: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_nhia_claim_benefit_usage ON public.nhia_claims;
CREATE TRIGGER trg_nhia_claim_benefit_usage
  AFTER UPDATE OF status ON public.nhia_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.update_benefit_usage_on_claim();

-- ══════════════════════════════════════════════
-- 4. Pre-authorization workflow (N-2)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.preauthorizations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id            UUID NOT NULL REFERENCES public.tenants(id)    ON DELETE RESTRICT,
  facility_id          UUID NOT NULL REFERENCES public.facilities(id)  ON DELETE RESTRICT,
  patient_id           UUID NOT NULL REFERENCES public.patients(id)    ON DELETE RESTRICT,
  patient_insurance_id UUID REFERENCES public.patient_insurance(id)    ON DELETE SET NULL,
  insurer_id           UUID REFERENCES public.insurers(id)             ON DELETE SET NULL,

  -- What is being authorized
  procedure_code       TEXT NOT NULL,  -- CPT / local procedure code
  procedure_name       TEXT NOT NULL,
  diagnosis_code       TEXT,           -- ICD-10 supporting the request
  clinical_justification TEXT,

  -- Request details
  requested_by         UUID REFERENCES public.users(id),
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  urgency              TEXT NOT NULL DEFAULT 'routine'
    CHECK (urgency IN ('routine','urgent','emergency')),
  estimated_cost       NUMERIC(12,2),

  -- Approval
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',    -- awaiting insurer decision
      'approved',
      'partially_approved',
      'rejected',
      'expired',
      'cancelled'
    )),
  approval_reference   TEXT,           -- insurer-issued PA number
  approved_at          TIMESTAMPTZ,
  approved_by_insurer  TEXT,
  approved_amount      NUMERIC(12,2),
  valid_from           DATE,
  expires_at           DATE,
  rejection_reason     TEXT,

  -- Audit
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_pa_expires_after_valid
    CHECK (expires_at IS NULL OR valid_from IS NULL OR expires_at >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_preauth_patient
  ON public.preauthorizations(patient_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_preauth_facility_status
  ON public.preauthorizations(facility_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_preauth_pending
  ON public.preauthorizations(insurer_id, status, requested_at ASC)
  WHERE status = 'pending';

CREATE TRIGGER update_preauthorizations_updated_at
  BEFORE UPDATE ON public.preauthorizations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.preauthorizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical and finance staff can manage preauthorizations"
  ON public.preauthorizations FOR ALL
  USING (facility_id = public.get_user_facility_id());

COMMENT ON TABLE public.preauthorizations IS
  'NHIA/insurer pre-authorization requests for procedures and admissions. '
  'PA reference must be recorded before billing certain covered services.';

-- ══════════════════════════════════════════════
-- 5. Fee exemption tracking (N-5)
--    Ethiopia exempts specific population groups from user fees
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fee_exemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id       UUID NOT NULL REFERENCES public.tenants(id)   ON DELETE RESTRICT,
  facility_id     UUID NOT NULL REFERENCES public.facilities(id) ON DELETE RESTRICT,
  patient_id      UUID NOT NULL REFERENCES public.patients(id)  ON DELETE RESTRICT,

  exemption_type  TEXT NOT NULL
    CHECK (exemption_type IN (
      'under_5',          -- children under 5 years
      'antenatal',        -- pregnant women (ANC)
      'delivery',         -- institutional delivery
      'postnatal',        -- postnatal care
      'family_planning',  -- family planning services
      'hiv_art',          -- HIV/ART programme
      'tb',               -- TB DOTS
      'elderly',          -- 65+ years
      'disability',       -- persons with disability
      'indigent',         -- indigent/extreme poverty
      'other'
    )),
  exemption_basis TEXT,       -- policy reference or programme name
  valid_from      DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until     DATE,       -- NULL = indefinite
  status          TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','revoked')),
  verified_by     UUID REFERENCES public.users(id),
  verified_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_exemptions_patient
  ON public.fee_exemptions(patient_id, status)
  WHERE status = 'active';

CREATE TRIGGER update_fee_exemptions_updated_at
  BEFORE UPDATE ON public.fee_exemptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.fee_exemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view fee exemptions"
  ON public.fee_exemptions FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "Receptionist/admin can manage fee exemptions"
  ON public.fee_exemptions FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin','receptionist','super_admin')
    )
  );

COMMENT ON TABLE public.fee_exemptions IS
  'Ethiopia national fee exemption scheme. Tracks which patients are exempt '
  'from user fees and under which programme (under-5, ANC, TB, HIV/ART, etc.).';

-- ══════════════════════════════════════════════
-- 6. DHIS2 organisation unit UID on facilities (D-2)
-- ══════════════════════════════════════════════
ALTER TABLE public.facilities
  ADD COLUMN IF NOT EXISTS dhis2_org_unit_uid  TEXT UNIQUE,  -- 11-char DHIS2 UID
  ADD COLUMN IF NOT EXISTS dhis2_level         SMALLINT,     -- DHIS2 org hierarchy level
  ADD COLUMN IF NOT EXISTS hmis_code           TEXT;         -- Ethiopia HMIS facility code

COMMENT ON COLUMN public.facilities.dhis2_org_unit_uid IS
  'DHIS2 Organisation Unit UID (11-character alphanumeric). '
  'Required to map facility records to DHIS2 org hierarchy for HMIS reporting.';
COMMENT ON COLUMN public.facilities.hmis_code IS
  'Ethiopia Health Management Information System (HMIS) facility code. '
  'Used for official HMIS reporting and NHIA facility registration.';

-- ══════════════════════════════════════════════
-- 7. Reporting periods table (D-4)
--    Canonical period boundaries for HMIS/DHIS2 reporting
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.reporting_periods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_type  TEXT NOT NULL
    CHECK (period_type IN ('monthly','quarterly','semi_annual','annual','weekly')),
  period_name  TEXT NOT NULL,    -- e.g. '2025-Q1', '2025-03', '2024-2025'
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  fiscal_year  SMALLINT,         -- Ethiopian fiscal year (EFY)
  is_closed    BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_reporting_period_name UNIQUE (period_type, period_name),
  CONSTRAINT chk_period_end_after_start CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_reporting_periods_type_date
  ON public.reporting_periods(period_type, start_date DESC);

COMMENT ON TABLE public.reporting_periods IS
  'Canonical reporting period calendar for HMIS/DHIS2 data submission. '
  'period_name follows DHIS2 period identifier format (e.g. 202503 for March 2025). '
  'fiscal_year tracks Ethiopian Fiscal Year (EFY, starts July 8).';

-- Seed current and recent periods (idempotent)
INSERT INTO public.reporting_periods (period_type, period_name, start_date, end_date, fiscal_year)
VALUES
  ('monthly',   '202501', '2025-01-01', '2025-01-31', 2017),
  ('monthly',   '202502', '2025-02-01', '2025-02-28', 2017),
  ('monthly',   '202503', '2025-03-01', '2025-03-31', 2017),
  ('monthly',   '202504', '2025-04-01', '2025-04-30', 2017),
  ('monthly',   '202505', '2025-05-01', '2025-05-31', 2017),
  ('monthly',   '202506', '2025-06-01', '2025-06-30', 2017),
  ('monthly',   '202507', '2025-07-01', '2025-07-31', 2017),
  ('monthly',   '202508', '2025-08-01', '2025-08-31', 2017),
  ('monthly',   '202509', '2025-09-01', '2025-09-30', 2017),
  ('monthly',   '202510', '2025-10-01', '2025-10-31', 2017),
  ('monthly',   '202511', '2025-11-01', '2025-11-30', 2017),
  ('monthly',   '202512', '2025-12-01', '2025-12-31', 2017),
  ('monthly',   '202601', '2026-01-01', '2026-01-31', 2018),
  ('monthly',   '202602', '2026-02-01', '2026-02-28', 2018),
  ('monthly',   '202603', '2026-03-01', '2026-03-31', 2018),
  ('quarterly', '2025Q1', '2025-01-01', '2025-03-31', 2017),
  ('quarterly', '2025Q2', '2025-04-01', '2025-06-30', 2017),
  ('quarterly', '2025Q3', '2025-07-01', '2025-09-30', 2017),
  ('quarterly', '2025Q4', '2025-10-01', '2025-12-31', 2017),
  ('quarterly', '2026Q1', '2026-01-01', '2026-03-31', 2018),
  ('annual',    '2025',   '2025-01-01', '2025-12-31', 2017),
  ('annual',    '2026',   '2026-01-01', '2026-12-31', 2018)
ON CONFLICT (period_type, period_name) DO NOTHING;

-- ══════════════════════════════════════════════
-- 8. DHIS2 aggregate data value scaffold (D-1, D-3)
--    Stores pre-aggregated indicator values ready for DHIS2 import
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.dhis2_data_values (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- DHIS2 data element identifiers
  data_element_uid  TEXT NOT NULL,   -- DHIS2 data element UID
  data_element_name TEXT,            -- human-readable name
  category_option_combo_uid TEXT DEFAULT 'HllvX50cXC0',  -- default disaggregation

  -- Organisation
  org_unit_uid      TEXT NOT NULL,   -- maps to facilities.dhis2_org_unit_uid
  facility_id       UUID REFERENCES public.facilities(id) ON DELETE SET NULL,
  tenant_id         UUID REFERENCES public.tenants(id)    ON DELETE SET NULL,

  -- Period
  period            TEXT NOT NULL,   -- DHIS2 period format: 202503, 2025Q1, etc.
  reporting_period_id UUID REFERENCES public.reporting_periods(id) ON DELETE SET NULL,

  -- Value
  value             TEXT NOT NULL,   -- always stored as text per DHIS2 spec
  comment           TEXT,

  -- Status
  is_submitted      BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at      TIMESTAMPTZ,
  submission_batch  TEXT,            -- batch ID for bulk submissions

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_dhis2_data_value
    UNIQUE (data_element_uid, category_option_combo_uid, org_unit_uid, period)
);

CREATE INDEX IF NOT EXISTS idx_dhis2_dv_org_period
  ON public.dhis2_data_values(org_unit_uid, period);
CREATE INDEX IF NOT EXISTS idx_dhis2_dv_pending
  ON public.dhis2_data_values(is_submitted, period)
  WHERE is_submitted = FALSE;

CREATE TRIGGER update_dhis2_data_values_updated_at
  BEFORE UPDATE ON public.dhis2_data_values
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.dhis2_data_values IS
  'Pre-aggregated indicator values ready for DHIS2 ADX/JSON import. '
  'Populated by scheduled jobs that aggregate visit/lab/immunization data '
  'for each reporting period. is_submitted=FALSE = pending upload to DHIS2.';

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'FIX_22: nhia_claims=%, benefit_usage=%, preauthorizations=%, '
    'fee_exemptions=%, dhis2_data_values=%, reporting_periods=%',
    (SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='nhia_claims')),
    (SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='insurance_benefit_usage')),
    (SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='preauthorizations')),
    (SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='fee_exemptions')),
    (SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='dhis2_data_values')),
    (SELECT COUNT(*) FROM public.reporting_periods);
END
$$;
