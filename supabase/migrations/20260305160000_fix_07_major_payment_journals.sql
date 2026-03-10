-- ============================================================
-- FIX 07 — MAJOR: Double-Entry Payment Journal & Reconciliation
-- ============================================================
-- Problem:
--   The existing payments table records totals but has no double-entry
--   accounting journal (no debit/credit legs), no reconciliation
--   against cash drawer / bank, and no formal audit for financial
--   corrections.  This means:
--     • Revenue reports can't be reconciled against bank statements
--     • Corrections (voids, refunds) leave no audit trail
--     • Day-end cash reconciliation is manual / spreadsheet-based
--     • Non-compliant with basic healthcare financial governance
--
-- Fix:
--   1. payment_journals   — individual debit/credit ledger lines
--                           (one journal entry = two or more lines)
--   2. payment_reconciliations — day-end or shift-end tally of
--                           actual cash/bank vs. system totals
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────
-- 1. payment_journals (double-entry ledger lines)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_journals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant / Facility scope
  tenant_id         UUID NOT NULL REFERENCES public.tenants(id),
  facility_id       UUID NOT NULL REFERENCES public.facilities(id),

  -- Journal grouping: one business event = one journal_entry_id
  -- (e.g. a patient payment creates 2 lines: cash DR + revenue CR)
  journal_entry_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Line classification
  account_code      TEXT NOT NULL,       -- e.g. 'CASH', 'REVENUE_CONSULT', 'AR', 'REFUND'
  account_name      TEXT NOT NULL,       -- Human label

  -- Double-entry amounts (always positive; direction set by debit/credit)
  debit_amount      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit_amount >= 0),
  credit_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  currency          TEXT NOT NULL DEFAULT 'ETB',   -- ISO 4217

  -- Links to source records (optional but important for traceability)
  payment_id        UUID REFERENCES public.payments(id),
  visit_id          UUID REFERENCES public.visits(id),
  patient_id        UUID REFERENCES public.patients(id),

  -- Narrative
  description       TEXT,
  reference_number  TEXT,    -- receipt number, bank ref, etc.

  -- Journal entry type
  entry_type        TEXT NOT NULL DEFAULT 'standard'
    CHECK (entry_type IN (
      'standard',    -- normal payment
      'void',        -- cancellation / void of an earlier entry
      'refund',      -- money returned to patient
      'adjustment',  -- correction / write-off
      'opening',     -- opening balances
      'reconciliation' -- reconciliation adjustment
    )),

  -- If this is a void/adjustment, link to the original entry
  reverses_journal_entry_id UUID,

  -- Audit
  created_by        UUID NOT NULL REFERENCES public.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at         TIMESTAMPTZ,   -- when finalised/posted (NULL = draft)

  -- Constraint: each line must have exactly one non-zero side
  CONSTRAINT chk_journal_one_side_nonzero
    CHECK (
      (debit_amount > 0 AND credit_amount = 0)
      OR (credit_amount > 0 AND debit_amount = 0)
    ),

  -- Constraint: can't void yourself
  CONSTRAINT chk_journal_no_self_reverse
    CHECK (reverses_journal_entry_id != id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pj_tenant_facility_date
  ON public.payment_journals(tenant_id, facility_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_pj_journal_entry
  ON public.payment_journals(journal_entry_id);

CREATE INDEX IF NOT EXISTS idx_pj_payment
  ON public.payment_journals(payment_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pj_visit
  ON public.payment_journals(visit_id)
  WHERE visit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pj_account_date
  ON public.payment_journals(facility_id, account_code, entry_date DESC);

-- Trigger
CREATE TRIGGER update_payment_journals_updated_at
  BEFORE UPDATE ON public.payment_journals
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.payment_journals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Finance staff can view payment journals"
  ON public.payment_journals FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "Finance staff can insert payment journals"
  ON public.payment_journals FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role::TEXT IN ('admin', 'receptionist', 'accountant', 'super_admin')
    )
  );

-- ──────────────────────────────────────────────
-- 2. payment_reconciliations (shift/day-end cash reconciliation)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_reconciliations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant / Facility scope
  tenant_id             UUID NOT NULL REFERENCES public.tenants(id),
  facility_id           UUID NOT NULL REFERENCES public.facilities(id),

  -- Period
  reconciliation_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  shift                 TEXT CHECK (shift IN ('morning', 'afternoon', 'night', 'full_day')),

  -- Totals from system
  system_cash_total     NUMERIC(14,2) NOT NULL DEFAULT 0,
  system_card_total     NUMERIC(14,2) NOT NULL DEFAULT 0,
  system_mobile_total   NUMERIC(14,2) NOT NULL DEFAULT 0,
  system_credit_total   NUMERIC(14,2) NOT NULL DEFAULT 0,  -- credit / insurance
  system_total          NUMERIC(14,2) GENERATED ALWAYS AS (
    system_cash_total + system_card_total + system_mobile_total + system_credit_total
  ) STORED,

  -- Actual cash counted by cashier
  actual_cash_counted   NUMERIC(14,2),
  actual_card_total     NUMERIC(14,2),
  actual_mobile_total   NUMERIC(14,2),

  -- Variance (system - actual; positive = shortage, negative = overage)
  cash_variance         NUMERIC(14,2) GENERATED ALWAYS AS (
    system_cash_total - COALESCE(actual_cash_counted, system_cash_total)
  ) STORED,

  -- Status
  status                TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'disputed')),

  -- Notes and resolution
  cashier_notes         TEXT,
  supervisor_notes      TEXT,
  variance_explanation  TEXT,

  -- Signatories
  prepared_by           UUID NOT NULL REFERENCES public.users(id),
  reviewed_by           UUID REFERENCES public.users(id),
  approved_by           UUID REFERENCES public.users(id),
  reviewed_at           TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,

  -- Audit
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One reconciliation per facility per date per shift
  UNIQUE (facility_id, reconciliation_date, shift)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pr_facility_date
  ON public.payment_reconciliations(facility_id, reconciliation_date DESC);

CREATE INDEX IF NOT EXISTS idx_pr_status
  ON public.payment_reconciliations(facility_id, status)
  WHERE status != 'approved';

-- Trigger
CREATE TRIGGER update_payment_reconciliations_updated_at
  BEFORE UPDATE ON public.payment_reconciliations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.payment_reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view reconciliations"
  ON public.payment_reconciliations FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "Receptionist/admin can create reconciliations"
  ON public.payment_reconciliations FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role::TEXT IN ('admin', 'receptionist', 'accountant', 'super_admin')
    )
  );

CREATE POLICY "Admin can approve reconciliations"
  ON public.payment_reconciliations FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role::TEXT IN ('admin', 'super_admin')
    )
  );

-- ──────────────────────────────────────────────
-- 3. Backfill journal entries from existing payments
--    (creates opening-balance style entries for historical data)
-- ──────────────────────────────────────────────
DO $$
DECLARE
  v_date_expr     TEXT;
  v_creator_expr  TEXT;
  v_currency_expr TEXT;
  v_method_expr   TEXT;
  v_cols_ok       BOOLEAN;
BEGIN
  -- Check payments table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payments'
  ) THEN
    RAISE NOTICE 'payments table not found — skipping backfill.';
    RETURN;
  END IF;

  -- Verify minimum required columns are present
  SELECT bool_and(EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'payments'
      AND column_name  = col
  ))
  INTO v_cols_ok
  FROM unnest(ARRAY['id','tenant_id','facility_id','amount_paid','visit_id','patient_id','created_at']) AS col;

  IF NOT v_cols_ok THEN
    RAISE NOTICE 'payments table is missing required columns — skipping backfill.';
    RETURN;
  END IF;

  -- Resolve optional column expressions (fall back gracefully)
  v_date_expr := CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='payments' AND column_name='payment_date')
    THEN 'p.payment_date::DATE'
    ELSE 'p.created_at::DATE'
  END;

  v_creator_expr := CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='payments' AND column_name='received_by')
    THEN 'p.received_by'
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='payments' AND column_name='created_by')
    THEN 'p.created_by'
    ELSE '(SELECT id FROM public.users ORDER BY created_at LIMIT 1)'
  END;

  v_currency_expr := CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='payments' AND column_name='currency')
    THEN 'COALESCE(p.currency, ''ETB'')'
    ELSE '''ETB'''
  END;

  v_method_expr := CASE
    WHEN EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='payments' AND column_name='payment_method')
    THEN 'COALESCE(p.payment_method::TEXT, ''cash'')'
    ELSE '''cash'''
  END;

  -- Only backfill if journal is empty (idempotent)
  IF NOT EXISTS (SELECT 1 FROM public.payment_journals LIMIT 1) THEN
    EXECUTE format(
      'INSERT INTO public.payment_journals (
         tenant_id, facility_id, journal_entry_id, entry_date,
         account_code, account_name,
         debit_amount, credit_amount, currency,
         payment_id, visit_id, patient_id,
         description, entry_type, created_by, created_at, posted_at
       )
       SELECT
         p.tenant_id, p.facility_id,
         gen_random_uuid(),
         %s,
         ''CASH'', ''Cash Receipts'',
         p.amount_paid, 0,
         %s,
         p.id, p.visit_id, p.patient_id,
         ''Historical payment import — '' || %s,
         ''opening'',
         %s,
         p.created_at, p.created_at
       FROM public.payments p
       WHERE p.amount_paid > 0',
      v_date_expr, v_currency_expr, v_method_expr, v_creator_expr
    );

    RAISE NOTICE 'Backfilled payment journal lines.';
  ELSE
    RAISE NOTICE 'Journal already has rows — skipping backfill.';
  END IF;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT 'payment_journals'       AS table_name, count(*) AS rows FROM public.payment_journals
UNION ALL
SELECT 'payment_reconciliations', count(*) FROM public.payment_reconciliations;
