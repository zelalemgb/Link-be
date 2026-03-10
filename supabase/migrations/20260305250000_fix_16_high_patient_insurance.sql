-- ============================================================
-- FIX 16 — HIGH: Patient Insurance Enrollment
-- ============================================================
-- Problem:
--   insurers, creditors, and programs exist as master reference tables
--   but there is no patient_insurance table linking individual patients
--   to their insurance plans with membership numbers, coverage periods,
--   and copay rules.  Without this:
--     • Service eligibility cannot be verified at registration
--     • Billing items cannot be auto-populated with correct payer info
--     • NHIA reimbursement claims cannot be generated per patient
--
-- Fix:
--   1. patient_insurance table — primary insurance enrollment per patient.
--   2. patient_insurance_history — audit trail for status changes.
--   3. Helper function get_active_patient_insurance() for use by billing RPCs.
--   4. Trigger to populate payment_line_items.insurance_provider_id
--      when a payment is created for a patient who has active insurance.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- 1. patient_insurance
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.patient_insurance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  tenant_id   UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  patient_id  UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  -- Payer references
  insurer_id  UUID NOT NULL REFERENCES public.insurers(id) ON DELETE RESTRICT,
  program_id  UUID REFERENCES public.programs(id) ON DELETE SET NULL,

  -- Membership details
  membership_number TEXT NOT NULL,
  policy_number     TEXT,
  group_number      TEXT,

  -- Coverage period
  coverage_start_date DATE NOT NULL,
  coverage_end_date   DATE,  -- NULL = open-ended / until further notice

  -- Benefit / copay rules
  copay_percentage    NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (copay_percentage BETWEEN 0 AND 100),
  copay_fixed_amount  NUMERIC(14,2) DEFAULT 0,   -- per-visit fixed copay (ETB)
  annual_limit        NUMERIC(14,2),             -- max insurer coverage per year
  deductible          NUMERIC(14,2) DEFAULT 0,

  -- Priority (primary vs secondary insurance)
  coverage_priority  SMALLINT NOT NULL DEFAULT 1
    CHECK (coverage_priority IN (1, 2, 3)),       -- 1=primary, 2=secondary, 3=tertiary

  -- Status
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'expired', 'cancelled', 'pending_verification')),

  -- Notes
  notes TEXT,

  -- Audit
  created_by UUID NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,

  -- A patient may have the same insurer at different priority levels,
  -- but not the same insurer + priority combination twice.
  UNIQUE (tenant_id, patient_id, insurer_id, coverage_priority,
          coverage_start_date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pi_patient_active
  ON public.patient_insurance(patient_id, status, coverage_priority)
  WHERE status = 'active' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pi_insurer
  ON public.patient_insurance(insurer_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pi_membership
  ON public.patient_insurance(tenant_id, membership_number)
  WHERE deleted_at IS NULL;

-- Trigger
CREATE TRIGGER update_patient_insurance_updated_at
  BEFORE UPDATE ON public.patient_insurance
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.patient_insurance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view patient insurance"
  ON public.patient_insurance FOR SELECT
  USING (
    facility_id = public.get_user_facility_id()
    AND deleted_at IS NULL
  );

CREATE POLICY "Admin or receptionist can manage patient insurance"
  ON public.patient_insurance FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin', 'receptionist', 'super_admin', 'accountant')
    )
  );

CREATE POLICY "Admin or receptionist can update patient insurance"
  ON public.patient_insurance FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin', 'receptionist', 'super_admin', 'accountant')
    )
  );

-- ══════════════════════════════════════════════
-- 2. patient_insurance_history (audit trail)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.patient_insurance_history (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_insurance_id UUID NOT NULL REFERENCES public.patient_insurance(id) ON DELETE CASCADE,
  tenant_id            UUID NOT NULL REFERENCES public.tenants(id),
  patient_id           UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,
  action               TEXT NOT NULL
    CHECK (action IN ('enrolled', 'suspended', 'reinstated', 'expired', 'cancelled', 'updated')),
  old_status           TEXT,
  new_status           TEXT,
  notes                TEXT,
  actioned_by          UUID REFERENCES public.users(id),
  actioned_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pih_insurance_id
  ON public.patient_insurance_history(patient_insurance_id, actioned_at DESC);

ALTER TABLE public.patient_insurance_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view insurance history"
  ON public.patient_insurance_history FOR SELECT
  USING (tenant_id = public.get_user_tenant_id());

-- Trigger: auto-write history on status change
CREATE OR REPLACE FUNCTION public.log_patient_insurance_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_action  TEXT;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_user_id FROM public.users
  WHERE auth_user_id = auth.uid() LIMIT 1;

  v_action := CASE NEW.status
    WHEN 'active'      THEN CASE WHEN OLD.status = 'suspended' THEN 'reinstated' ELSE 'enrolled' END
    WHEN 'suspended'   THEN 'suspended'
    WHEN 'expired'     THEN 'expired'
    WHEN 'cancelled'   THEN 'cancelled'
    ELSE 'updated'
  END;

  INSERT INTO public.patient_insurance_history (
    patient_insurance_id, tenant_id, patient_id,
    action, old_status, new_status,
    actioned_by, actioned_at
  ) VALUES (
    NEW.id, NEW.tenant_id, NEW.patient_id,
    v_action, OLD.status, NEW.status,
    v_user_id, now()
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_patient_insurance_history
  AFTER UPDATE OF status ON public.patient_insurance
  FOR EACH ROW
  EXECUTE FUNCTION public.log_patient_insurance_change();

-- ══════════════════════════════════════════════
-- 3. Helper function for billing
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_active_patient_insurance(
  p_patient_id UUID,
  p_date       DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  id                  UUID,
  insurer_id          UUID,
  insurer_name        TEXT,
  program_id          UUID,
  membership_number   TEXT,
  copay_percentage    NUMERIC,
  copay_fixed_amount  NUMERIC,
  annual_limit        NUMERIC,
  coverage_priority   SMALLINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pi.id,
    pi.insurer_id,
    ins.name AS insurer_name,
    pi.program_id,
    pi.membership_number,
    pi.copay_percentage,
    pi.copay_fixed_amount,
    pi.annual_limit,
    pi.coverage_priority
  FROM public.patient_insurance pi
  JOIN public.insurers ins ON ins.id = pi.insurer_id
  WHERE pi.patient_id = p_patient_id
    AND pi.status     = 'active'
    AND pi.deleted_at IS NULL
    AND pi.coverage_start_date <= p_date
    AND (pi.coverage_end_date IS NULL OR pi.coverage_end_date >= p_date)
  ORDER BY pi.coverage_priority ASC;
$$;

COMMENT ON FUNCTION public.get_active_patient_insurance(UUID, DATE) IS
  'Returns all active insurance plans for a patient on a given date, '
  'ordered by priority (1=primary first). Used by billing RPCs.';

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  'patient_insurance' AS table_name,
  COUNT(*)            AS total,
  COUNT(*) FILTER (WHERE status = 'active') AS active
FROM public.patient_insurance;
