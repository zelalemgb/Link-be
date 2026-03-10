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
DROP TABLE IF EXISTS public.stock_movements CASCADE;
DROP TABLE IF EXISTS public.payment_transactions CASCADE;
DROP TABLE IF EXISTS public.payment_line_items CASCADE;
DROP TABLE IF EXISTS public.payments CASCADE;
DROP TABLE IF EXISTS public.inventory_items CASCADE;
DROP TABLE IF EXISTS public.suppliers CASCADE;
DROP TABLE IF EXISTS public.visits CASCADE;
DROP TABLE IF EXISTS public.patients CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;

CREATE TABLE public.facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE public.patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE public.visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE public.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID REFERENCES public.facilities(id),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  dosage_form TEXT NOT NULL,
  unit_of_measure TEXT NOT NULL DEFAULT 'units',
  reorder_level INTEGER DEFAULT 0,
  max_stock_level INTEGER,
  unit_cost NUMERIC(10,2),
  facility_id UUID REFERENCES public.facilities(id),
  is_active BOOLEAN DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_status public.payment_status_enum NOT NULL DEFAULT 'pending',
  cashier_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

CREATE TABLE public.payment_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (
    item_type IN ('consultation', 'service', 'medication', 'lab_test', 'imaging', 'procedure')
  ),
  item_reference_id UUID,
  description TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  subtotal NUMERIC(10,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (
    payment_method IN ('cash', 'insurance', 'credit', 'free')
  ),
  insurance_provider TEXT,
  insurance_claim_number TEXT,
  payment_status public.payment_status_enum NOT NULL DEFAULT 'pending',
  discount_percentage NUMERIC(5,2) DEFAULT 0,
  discount_amount NUMERIC(10,2) DEFAULT 0,
  final_amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

CREATE TABLE public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (
    payment_method IN ('cash', 'insurance', 'credit', 'mobile_money', 'bank_transfer', 'check')
  ),
  reference_number TEXT,
  transaction_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  cashier_id UUID NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  movement_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  batch_number TEXT,
  expiry_date DATE,
  supplier_id UUID REFERENCES public.suppliers(id),
  reference_number TEXT,
  source_facility UUID REFERENCES public.facilities(id),
  destination_facility UUID REFERENCES public.facilities(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  patient_id UUID REFERENCES public.patients(id),
  visit_id UUID REFERENCES public.visits(id),
  unit_cost NUMERIC(10,2),
  total_cost NUMERIC(10,2),
  notes TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Apply canonical constraint migration under test
\ir ../migrations/20260215101000_enforce_finance_inventory_constraints.sql

-- Seed reference data
INSERT INTO public.facilities DEFAULT VALUES RETURNING id AS facility_id \gset
INSERT INTO public.patients DEFAULT VALUES RETURNING id AS patient_id \gset
INSERT INTO public.visits DEFAULT VALUES RETURNING id AS visit_id \gset
INSERT INTO public.suppliers (facility_id, created_by)
VALUES (:'facility_id', gen_random_uuid())
RETURNING id AS supplier_id \gset

INSERT INTO public.inventory_items (
  name, dosage_form, unit_of_measure, reorder_level, unit_cost,
  facility_id, created_by
) VALUES (
  'Paracetamol', 'tablet', 'units', 10, 5.25,
  :'facility_id', gen_random_uuid()
) RETURNING id AS inventory_item_id \gset

-- Valid payment data should succeed
INSERT INTO public.payments (
  visit_id, patient_id, facility_id, total_amount, amount_paid, amount_due,
  cashier_id
) VALUES (
  :'visit_id', :'patient_id', :'facility_id', 100.00, 25.00, 75.00,
  gen_random_uuid()
) RETURNING id AS payment_id \gset

-- Valid payment line item and transaction
INSERT INTO public.payment_line_items (
  payment_id, item_type, description, unit_price, quantity, subtotal,
  payment_method, final_amount
) VALUES (
  :'payment_id', 'service', 'Consultation', 50.00, 1, 50.00,
  'cash', 50.00
) RETURNING id AS payment_line_item_id \gset

INSERT INTO public.payment_transactions (
  payment_id, amount, payment_method, cashier_id
) VALUES (
  :'payment_id', 25.00, 'cash', gen_random_uuid()
);

-- Valid stock movement
INSERT INTO public.stock_movements (
  inventory_item_id, movement_type, quantity, balance_after,
  supplier_id, facility_id, unit_cost, total_cost, created_by
) VALUES (
  :'inventory_item_id', 'receipt', 20, 20,
  :'supplier_id', :'facility_id', 5.25, 105.00, gen_random_uuid()
);

-- Payments should reject negative totals
DO $$
DECLARE
  facility UUID;
  patient UUID;
  visit UUID;
BEGIN
  SELECT id INTO facility FROM public.facilities LIMIT 1;
  SELECT id INTO patient FROM public.patients LIMIT 1;
  SELECT id INTO visit FROM public.visits LIMIT 1;
  BEGIN
    INSERT INTO public.payments (
      visit_id, patient_id, facility_id, total_amount, amount_paid, amount_due,
      cashier_id
    ) VALUES (
      visit, patient, facility, -5.00, 0, 5.00, gen_random_uuid()
    );
    RAISE EXCEPTION 'Expected payments_total_amount_non_negative to trigger';
  EXCEPTION WHEN check_violation THEN
    -- expected
    NULL;
  END;
END;
$$;

-- Payments should enforce amount_due calculation
DO $$
DECLARE
  facility UUID;
  patient UUID;
  visit UUID;
BEGIN
  SELECT id INTO facility FROM public.facilities LIMIT 1;
  SELECT id INTO patient FROM public.patients LIMIT 1;
  SELECT id INTO visit FROM public.visits LIMIT 1;
  BEGIN
    INSERT INTO public.payments (
      visit_id, patient_id, facility_id, total_amount, amount_paid, amount_due,
      cashier_id
    ) VALUES (
      visit, patient, facility, 80.00, 20.00, 80.00, gen_random_uuid()
    );
    RAISE EXCEPTION 'Expected payments_amount_consistency to trigger';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

-- Payment line items should reject negative quantity
DO $$
DECLARE
  payment UUID;
BEGIN
  SELECT id INTO payment FROM public.payments ORDER BY created_at LIMIT 1;
  BEGIN
    INSERT INTO public.payment_line_items (
      payment_id, item_type, description, unit_price, quantity, subtotal,
      payment_method, final_amount
    ) VALUES (
      payment, 'service', 'Follow-up', 25.00, -1, -25.00, 'cash', -25.00
    );
    RAISE EXCEPTION 'Expected payment_line_items_quantity_non_negative to trigger';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

-- Payment line items should enforce subtotal arithmetic
DO $$
DECLARE
  payment UUID;
BEGIN
  SELECT id INTO payment FROM public.payments ORDER BY created_at LIMIT 1;
  BEGIN
    INSERT INTO public.payment_line_items (
      payment_id, item_type, description, unit_price, quantity, subtotal,
      payment_method, discount_amount, final_amount
    ) VALUES (
      payment, 'service', 'Incorrect subtotal', 10.00, 2, 25.00,
      'cash', 0.00, 25.00
    );
    RAISE EXCEPTION 'Expected payment_line_items_subtotal_calculation to trigger';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

-- Payment transactions should reject negative amounts
DO $$
DECLARE
  payment UUID;
BEGIN
  SELECT id INTO payment FROM public.payments ORDER BY created_at LIMIT 1;
  BEGIN
    INSERT INTO public.payment_transactions (
      payment_id, amount, payment_method, cashier_id
    ) VALUES (
      payment, -10.00, 'cash', gen_random_uuid()
    );
    RAISE EXCEPTION 'Expected payment_transactions_amount_non_negative to trigger';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

-- Inventory items should reject negative unit cost
DO $$
DECLARE
  facility UUID;
BEGIN
  SELECT id INTO facility FROM public.facilities LIMIT 1;
  BEGIN
    INSERT INTO public.inventory_items (
      name, dosage_form, unit_of_measure, reorder_level, unit_cost,
      facility_id, created_by
    ) VALUES (
      'Ibuprofen', 'tablet', 'units', 5, -2.50, facility, gen_random_uuid()
    );
    RAISE EXCEPTION 'Expected inventory_items_unit_cost_non_negative to trigger';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

-- Stock movements should enforce non-negative quantity and cost math
DO $$
DECLARE
  item UUID;
  supplier UUID;
  facility UUID;
BEGIN
  SELECT id INTO item FROM public.inventory_items LIMIT 1;
  SELECT id INTO supplier FROM public.suppliers LIMIT 1;
  SELECT id INTO facility FROM public.facilities LIMIT 1;
  BEGIN
    INSERT INTO public.stock_movements (
      inventory_item_id, movement_type, quantity, balance_after,
      supplier_id, facility_id, unit_cost, total_cost, created_by
    ) VALUES (
      item, 'receipt', -5, -5, supplier, facility, 5.25, -26.25, gen_random_uuid()
    );
    RAISE EXCEPTION 'Expected stock_movements_quantity_non_negative to trigger';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.stock_movements (
      inventory_item_id, movement_type, quantity, balance_after,
      supplier_id, facility_id, unit_cost, total_cost, created_by
    ) VALUES (
      item, 'receipt', 5, 25, supplier, facility, 5.00, 10.00, gen_random_uuid()
    );
    RAISE EXCEPTION 'Expected stock_movements_total_cost_calculation to trigger';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;
