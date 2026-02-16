\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'payment_status_enum'
  ) THEN
    CREATE TYPE public.payment_status_enum AS ENUM (
      'pending', 'unpaid', 'partial', 'paid', 'cancelled', 'refunded', 'waived', 'disputed'
    );
  END IF;
END;
$$;

-- Reset objects for repeatable test runs
DROP TABLE IF EXISTS public.patient_bed_assignments CASCADE;
DROP TABLE IF EXISTS public.beds CASCADE;
DROP TABLE IF EXISTS public.wards CASCADE;
DROP TABLE IF EXISTS public.inventory_transactions CASCADE;
DROP TABLE IF EXISTS public.inventory_accounts CASCADE;
DROP TABLE IF EXISTS public.payment_transactions CASCADE;
DROP TABLE IF EXISTS public.payment_line_items CASCADE;
DROP TABLE IF EXISTS public.payments CASCADE;

-- Minimal schema needed for aggregate trigger verification
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  cashier_id UUID NOT NULL,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_status public.payment_status_enum NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.payment_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  description TEXT,
  final_amount NUMERIC(12,2) NOT NULL
);

CREATE TABLE public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.inventory_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name TEXT NOT NULL,
  ending_balance NUMERIC(18,2) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.inventory_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.inventory_accounts(id) ON DELETE CASCADE,
  value_delta NUMERIC(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.wards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  total_beds INTEGER DEFAULT 0,
  available_beds INTEGER DEFAULT 0,
  occupied_beds INTEGER DEFAULT 0,
  cleaning_beds INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.beds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id UUID NOT NULL REFERENCES public.wards(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
);

CREATE TABLE public.patient_bed_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ward_id UUID NOT NULL REFERENCES public.wards(id) ON DELETE CASCADE,
  bed_id UUID NOT NULL REFERENCES public.beds(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL,
  released_at TIMESTAMPTZ
);

-- Apply canonical migration under test
\ir ../migrations/20260215103000_automate_aggregate_recalculations.sql

CREATE OR REPLACE FUNCTION public.assert_true(condition boolean, failure_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT condition THEN
    RAISE EXCEPTION '%', failure_message;
  END IF;
END;
$$;

-- Payments aggregate trigger coverage
INSERT INTO public.payments (visit_id, patient_id, facility_id, cashier_id)
VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())
RETURNING id AS payment_id \gset

INSERT INTO public.payment_line_items (payment_id, description, final_amount)
VALUES (:'payment_id', 'Initial service', 150.00);

SELECT total_amount, amount_paid, amount_due, payment_status
FROM public.payments WHERE id = :'payment_id'
\gset

SELECT public.assert_true(:'total_amount'::NUMERIC = 150.00, format('Expected total_amount=150, got %s', :'total_amount'));
SELECT public.assert_true(:'amount_paid'::NUMERIC = 0, format('Expected amount_paid=0, got %s', :'amount_paid'));
SELECT public.assert_true(:'amount_due'::NUMERIC = 150.00, format('Expected amount_due=150, got %s', :'amount_due'));
SELECT public.assert_true(:'payment_status'::TEXT = 'pending', format('Expected payment_status=pending, got %s', :'payment_status'));

-- Payment transaction should drive amount_paid and status
INSERT INTO public.payment_transactions (payment_id, amount)
VALUES (:'payment_id', 50.00);

SELECT total_amount, amount_paid, amount_due, payment_status
FROM public.payments WHERE id = :'payment_id'
\gset

SELECT public.assert_true(:'amount_paid'::NUMERIC = 50.00, format('Expected amount_paid=50, got %s', :'amount_paid'));
SELECT public.assert_true(:'amount_due'::NUMERIC = 100.00, format('Expected amount_due=100, got %s', :'amount_due'));
SELECT public.assert_true(:'payment_status'::TEXT = 'partial', format('Expected payment_status=partial, got %s', :'payment_status'));

-- Updating line item should recompute totals and due
UPDATE public.payment_line_items
SET final_amount = 200.00
WHERE payment_id = :'payment_id';

SELECT total_amount, amount_paid, amount_due
FROM public.payments WHERE id = :'payment_id'
\gset

SELECT public.assert_true(:'total_amount'::NUMERIC = 200.00, format('Expected total_amount=200, got %s', :'total_amount'));
SELECT public.assert_true(:'amount_due'::NUMERIC = 150.00, format('Expected amount_due=150, got %s', :'amount_due'));

-- Removing the payment transaction should reset amount_paid
DELETE FROM public.payment_transactions WHERE payment_id = :'payment_id';

SELECT amount_paid, amount_due, payment_status
FROM public.payments WHERE id = :'payment_id'
\gset

SELECT public.assert_true(:'amount_paid'::NUMERIC = 0, format('Expected amount_paid=0, got %s', :'amount_paid'));
SELECT public.assert_true(:'amount_due'::NUMERIC = 200.00, format('Expected amount_due=200, got %s', :'amount_due'));
SELECT public.assert_true(:'payment_status'::TEXT = 'pending', format('Expected payment_status=pending, got %s', :'payment_status'));

-- Deleting the line item should clear totals entirely
DELETE FROM public.payment_line_items WHERE payment_id = :'payment_id';

SELECT total_amount, amount_paid, amount_due
FROM public.payments WHERE id = :'payment_id'
\gset

SELECT public.assert_true(:'total_amount'::NUMERIC = 0, format('Expected total_amount=0, got %s', :'total_amount'));
SELECT public.assert_true(:'amount_due'::NUMERIC = 0, format('Expected amount_due=0, got %s', :'amount_due'));

-- Inventory account balance recalculation tests
INSERT INTO public.inventory_accounts (account_name)
VALUES ('Main Pharmacy')
RETURNING id AS account_id \gset

INSERT INTO public.inventory_transactions (account_id, value_delta)
VALUES (:'account_id', 100.00);

SELECT ending_balance FROM public.inventory_accounts WHERE id = :'account_id'
\gset

SELECT public.assert_true(:'ending_balance'::NUMERIC = 100.00, format('Expected ending_balance=100, got %s', :'ending_balance'));

INSERT INTO public.inventory_transactions (account_id, value_delta)
VALUES (:'account_id', -20.00)
RETURNING id AS txn_id \gset

SELECT ending_balance FROM public.inventory_accounts WHERE id = :'account_id'
\gset

SELECT public.assert_true(:'ending_balance'::NUMERIC = 80.00, format('Expected ending_balance=80, got %s', :'ending_balance'));

UPDATE public.inventory_transactions
SET value_delta = -10.00
WHERE id = :'txn_id';

SELECT ending_balance FROM public.inventory_accounts WHERE id = :'account_id'
\gset

SELECT public.assert_true(:'ending_balance'::NUMERIC = 90.00, format('Expected ending_balance=90, got %s', :'ending_balance'));

DELETE FROM public.inventory_transactions
WHERE id = :'txn_id';

SELECT ending_balance FROM public.inventory_accounts WHERE id = :'account_id'
\gset

SELECT public.assert_true(:'ending_balance'::NUMERIC = 100.00, format('Expected ending_balance=100, got %s', :'ending_balance'));

-- Ward bed utilisation trigger tests
INSERT INTO public.wards (name, total_beds, available_beds, occupied_beds, cleaning_beds)
VALUES ('General Ward', 0, 0, 0, 0)
RETURNING id AS ward_id \gset

INSERT INTO public.beds (ward_id, status) VALUES
  (:'ward_id', 'AVAILABLE'),
  (:'ward_id', 'AVAILABLE'),
  (:'ward_id', 'CLEANING');

-- Prime the counts prior to assignments
SELECT public.update_bed_utilization(:'ward_id');

SELECT total_beds, available_beds, occupied_beds, cleaning_beds
FROM public.wards WHERE id = :'ward_id'
\gset

SELECT public.assert_true(:'total_beds'::INT = 3, format('Expected total_beds=3, got %s', :'total_beds'));
SELECT public.assert_true(:'available_beds'::INT = 2, format('Expected available_beds=2, got %s', :'available_beds'));
SELECT public.assert_true(:'cleaning_beds'::INT = 1, format('Expected cleaning_beds=1, got %s', :'cleaning_beds'));

INSERT INTO public.patient_bed_assignments (ward_id, bed_id, patient_id)
VALUES (:'ward_id', (SELECT id FROM public.beds WHERE ward_id = :'ward_id' AND status = 'AVAILABLE' LIMIT 1), gen_random_uuid())
RETURNING id AS active_assignment \gset

INSERT INTO public.patient_bed_assignments (ward_id, bed_id, patient_id)
VALUES (:'ward_id', (SELECT id FROM public.beds WHERE ward_id = :'ward_id' AND status = 'AVAILABLE' OFFSET 1 LIMIT 1), gen_random_uuid());

SELECT available_beds, occupied_beds
FROM public.wards WHERE id = :'ward_id'
\gset

SELECT public.assert_true(:'available_beds'::INT = 0, format('Expected available_beds=0, got %s', :'available_beds'));
SELECT public.assert_true(:'occupied_beds'::INT = 2, format('Expected occupied_beds=2, got %s', :'occupied_beds'));

UPDATE public.patient_bed_assignments
SET released_at = now()
WHERE id = :'active_assignment';

SELECT available_beds, occupied_beds
FROM public.wards WHERE id = :'ward_id'
\gset

SELECT public.assert_true(:'available_beds'::INT = 1, format('Expected available_beds=1, got %s', :'available_beds'));
SELECT public.assert_true(:'occupied_beds'::INT = 1, format('Expected occupied_beds=1, got %s', :'occupied_beds'));

DELETE FROM public.patient_bed_assignments
WHERE released_at IS NULL;

SELECT available_beds, occupied_beds
FROM public.wards WHERE id = :'ward_id'
\gset

SELECT public.assert_true(:'available_beds'::INT = 2, format('Expected available_beds=2, got %s', :'available_beds'));
SELECT public.assert_true(:'occupied_beds'::INT = 0, format('Expected occupied_beds=0, got %s', :'occupied_beds'));
