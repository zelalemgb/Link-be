\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
\i supabase/database/schemas/status_enums.sql

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

-- Apply migration under test
\i supabase/migrations/20251202153000_automate_aggregate_recalculations.sql

-- Payments aggregate trigger coverage
INSERT INTO public.payments (visit_id, patient_id, facility_id, cashier_id)
VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())
RETURNING id AS payment_id \gset

INSERT INTO public.payment_line_items (payment_id, description, final_amount)
VALUES (:'payment_id', 'Initial service', 150.00);

SELECT total_amount, amount_paid, amount_due, payment_status
FROM public.payments WHERE id = :'payment_id'
\gset

DO $$
BEGIN
  IF :'total_amount'::NUMERIC <> 150.00 THEN
    RAISE EXCEPTION 'Expected total_amount to be 150 after first line item, got %', :'total_amount';
  END IF;
  IF :'amount_paid'::NUMERIC <> 0 THEN
    RAISE EXCEPTION 'Expected amount_paid to remain 0 before transactions, got %', :'amount_paid';
  END IF;
  IF :'amount_due'::NUMERIC <> 150.00 THEN
    RAISE EXCEPTION 'Expected amount_due to mirror total_amount when unpaid, got %', :'amount_due';
  END IF;
  IF :'payment_status'::TEXT <> 'pending' THEN
    RAISE EXCEPTION 'Expected payment_status to remain pending, got %', :'payment_status';
  END IF;
END;
$$;

-- Payment transaction should drive amount_paid and status
INSERT INTO public.payment_transactions (payment_id, amount)
VALUES (:'payment_id', 50.00);

SELECT total_amount, amount_paid, amount_due, payment_status
FROM public.payments WHERE id = :'payment_id'
\gset

DO $$
BEGIN
  IF :'amount_paid'::NUMERIC <> 50.00 THEN
    RAISE EXCEPTION 'Expected amount_paid to reflect transaction amount, got %', :'amount_paid';
  END IF;
  IF :'amount_due'::NUMERIC <> 100.00 THEN
    RAISE EXCEPTION 'Expected amount_due to drop to 100, got %', :'amount_due';
  END IF;
  IF :'payment_status'::TEXT <> 'partial' THEN
    RAISE EXCEPTION 'Expected payment_status to be partial after partial payment, got %', :'payment_status';
  END IF;
END;
$$;

-- Updating line item should recompute totals and due
UPDATE public.payment_line_items
SET final_amount = 200.00
WHERE payment_id = :'payment_id';

SELECT total_amount, amount_paid, amount_due
FROM public.payments WHERE id = :'payment_id'
\gset

DO $$
BEGIN
  IF :'total_amount'::NUMERIC <> 200.00 THEN
    RAISE EXCEPTION 'Expected total_amount to update to 200, got %', :'total_amount';
  END IF;
  IF :'amount_due'::NUMERIC <> 150.00 THEN
    RAISE EXCEPTION 'Expected amount_due to become 150 after line item update, got %', :'amount_due';
  END IF;
END;
$$;

-- Removing the payment transaction should reset amount_paid
DELETE FROM public.payment_transactions WHERE payment_id = :'payment_id';

SELECT amount_paid, amount_due, payment_status
FROM public.payments WHERE id = :'payment_id'
\gset

DO $$
BEGIN
  IF :'amount_paid'::NUMERIC <> 0 THEN
    RAISE EXCEPTION 'Expected amount_paid to reset to 0 after deleting transaction, got %', :'amount_paid';
  END IF;
  IF :'amount_due'::NUMERIC <> 200.00 THEN
    RAISE EXCEPTION 'Expected amount_due to revert to total_amount when unpaid, got %', :'amount_due';
  END IF;
  IF :'payment_status'::TEXT <> 'pending' THEN
    RAISE EXCEPTION 'Expected payment_status to return to pending after deleting payment transaction, got %', :'payment_status';
  END IF;
END;
$$;

-- Deleting the line item should clear totals entirely
DELETE FROM public.payment_line_items WHERE payment_id = :'payment_id';

SELECT total_amount, amount_paid, amount_due
FROM public.payments WHERE id = :'payment_id'
\gset

DO $$
BEGIN
  IF :'total_amount'::NUMERIC <> 0 THEN
    RAISE EXCEPTION 'Expected total_amount to clear after deleting all line items, got %', :'total_amount';
  END IF;
  IF :'amount_due'::NUMERIC <> 0 THEN
    RAISE EXCEPTION 'Expected amount_due to clear after deleting all line items, got %', :'amount_due';
  END IF;
END;
$$;

-- Inventory account balance recalculation tests
INSERT INTO public.inventory_accounts (account_name)
VALUES ('Main Pharmacy')
RETURNING id AS account_id \gset

INSERT INTO public.inventory_transactions (account_id, value_delta)
VALUES (:'account_id', 100.00);

SELECT ending_balance FROM public.inventory_accounts WHERE id = :'account_id'
\gset

DO $$
BEGIN
  IF :'ending_balance'::NUMERIC <> 100.00 THEN
    RAISE EXCEPTION 'Expected ending_balance to be 100 after first transaction, got %', :'ending_balance';
  END IF;
END;
$$;

INSERT INTO public.inventory_transactions (account_id, value_delta)
VALUES (:'account_id', -20.00)
RETURNING id AS txn_id \gset

SELECT ending_balance FROM public.inventory_accounts WHERE id = :'account_id'
\gset

DO $$
BEGIN
  IF :'ending_balance'::NUMERIC <> 80.00 THEN
    RAISE EXCEPTION 'Expected ending_balance to be 80 after second transaction, got %', :'ending_balance';
  END IF;
END;
$$;

UPDATE public.inventory_transactions
SET value_delta = -10.00
WHERE id = :'txn_id';

SELECT ending_balance FROM public.inventory_accounts WHERE id = :'account_id'
\gset

DO $$
BEGIN
  IF :'ending_balance'::NUMERIC <> 90.00 THEN
    RAISE EXCEPTION 'Expected ending_balance to adjust to 90 after updating transaction, got %', :'ending_balance';
  END IF;
END;
$$;

DELETE FROM public.inventory_transactions
WHERE id = :'txn_id';

SELECT ending_balance FROM public.inventory_accounts WHERE id = :'account_id'
\gset

DO $$
BEGIN
  IF :'ending_balance'::NUMERIC <> 100.00 THEN
    RAISE EXCEPTION 'Expected ending_balance to revert to 100 after deleting second transaction, got %', :'ending_balance';
  END IF;
END;
$$;

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

DO $$
BEGIN
  IF :'total_beds'::INT <> 3 THEN
    RAISE EXCEPTION 'Expected total_beds to reflect three beds, got %', :'total_beds';
  END IF;
  IF :'available_beds'::INT <> 2 THEN
    RAISE EXCEPTION 'Expected two available beds before assignments, got %', :'available_beds';
  END IF;
  IF :'cleaning_beds'::INT <> 1 THEN
    RAISE EXCEPTION 'Expected one cleaning bed before assignments, got %', :'cleaning_beds';
  END IF;
END;
$$;

INSERT INTO public.patient_bed_assignments (ward_id, bed_id, patient_id)
VALUES
  (:'ward_id', (SELECT id FROM public.beds WHERE ward_id = :'ward_id' AND status = 'AVAILABLE' LIMIT 1), gen_random_uuid()),
  (:'ward_id', (SELECT id FROM public.beds WHERE ward_id = :'ward_id' AND status = 'AVAILABLE' OFFSET 1 LIMIT 1), gen_random_uuid())
RETURNING id AS active_assignment \gset

SELECT available_beds, occupied_beds
FROM public.wards WHERE id = :'ward_id'
\gset

DO $$
BEGIN
  IF :'available_beds'::INT <> 0 THEN
    RAISE EXCEPTION 'Expected available_beds to drop to 0 after occupying two beds, got %', :'available_beds';
  END IF;
  IF :'occupied_beds'::INT <> 2 THEN
    RAISE EXCEPTION 'Expected occupied_beds to be 2 after assignments, got %', :'occupied_beds';
  END IF;
END;
$$;

UPDATE public.patient_bed_assignments
SET released_at = now()
WHERE id = :'active_assignment';

SELECT available_beds, occupied_beds
FROM public.wards WHERE id = :'ward_id'
\gset

DO $$
BEGIN
  IF :'available_beds'::INT <> 1 THEN
    RAISE EXCEPTION 'Expected available_beds to increase to 1 after releasing one bed, got %', :'available_beds';
  END IF;
  IF :'occupied_beds'::INT <> 1 THEN
    RAISE EXCEPTION 'Expected occupied_beds to drop to 1 after releasing one bed, got %', :'occupied_beds';
  END IF;
END;
$$;

DELETE FROM public.patient_bed_assignments
WHERE released_at IS NULL;

SELECT available_beds, occupied_beds
FROM public.wards WHERE id = :'ward_id'
\gset

DO $$
BEGIN
  IF :'available_beds'::INT <> 2 THEN
    RAISE EXCEPTION 'Expected available_beds to return to 2 after deleting remaining assignment, got %', :'available_beds';
  END IF;
  IF :'occupied_beds'::INT <> 0 THEN
    RAISE EXCEPTION 'Expected occupied_beds to return to 0 after deleting remaining assignment, got %', :'occupied_beds';
  END IF;
END;
$$;
