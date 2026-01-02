-- Standardize status columns across payments, orders, inventory, and admissions

-- Ensure enums exist (idempotent in case of reruns)
DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'payment_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.payment_status_enum AS ENUM (
      'pending', 'unpaid', 'partial', 'paid', 'cancelled', 'refunded', 'waived', 'disputed'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'patient_order_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.patient_order_status_enum AS ENUM (
      'pending', 'approved', 'in_progress', 'completed', 'cancelled', 'discontinued'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'patient_order_item_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.patient_order_item_status_enum AS ENUM (
      'pending', 'collected', 'in_progress', 'completed', 'cancelled'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'lab_order_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.lab_order_status_enum AS ENUM (
      'pending', 'collected', 'processing', 'completed', 'cancelled', 'rejected'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'imaging_order_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.imaging_order_status_enum AS ENUM (
      'pending', 'scheduled', 'in_progress', 'completed', 'cancelled'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'medication_order_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.medication_order_status_enum AS ENUM (
      'pending', 'dispensed', 'administered', 'discontinued', 'cancelled'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'rx_item_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.rx_item_status_enum AS ENUM (
      'pending', 'dispensed', 'partially_dispensed', 'cancelled', 'discontinued'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'resupply_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.resupply_status_enum AS ENUM (
      'draft', 'submitted', 'verified', 'approved', 'cancelled'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'issue_order_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.issue_order_status_enum AS ENUM (
      'draft', 'pending', 'issued', 'cancelled'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'receiving_invoice_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.receiving_invoice_status_enum AS ENUM (
      'draft', 'submitted', 'invoiced', 'cancelled', 'voided'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'loss_adjustment_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.loss_adjustment_status_enum AS ENUM (
      'draft', 'submitted', 'approved', 'rejected'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'bed_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.bed_status_enum AS ENUM (
      'AVAILABLE', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'RESERVED', 'BLOCKED'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'admission_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.admission_status_enum AS ENUM (
      'active', 'discharged', 'transferred_out', 'absconded', 'deceased', 'cancelled'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'waitlist_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.waitlist_status_enum AS ENUM (
      'waiting', 'notified', 'admitted', 'cancelled', 'expired'
    );
  END IF;
END$$;

DO $$
BEGIN
  PERFORM 1 FROM pg_type WHERE typname = 'ipd_task_status_enum';
  IF NOT FOUND THEN
    CREATE TYPE public.ipd_task_status_enum AS ENUM (
      'pending', 'in_progress', 'completed', 'skipped', 'cancelled'
    );
  END IF;
END$$;

-- Payments
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_payment_status_check;
ALTER TABLE public.payments
  ALTER COLUMN payment_status TYPE public.payment_status_enum USING payment_status::public.payment_status_enum,
  ALTER COLUMN payment_status SET DEFAULT 'pending';

ALTER TABLE public.payment_line_items
  DROP CONSTRAINT IF EXISTS payment_line_items_payment_status_check;
ALTER TABLE public.payment_line_items
  ALTER COLUMN payment_status TYPE public.payment_status_enum USING payment_status::public.payment_status_enum,
  ALTER COLUMN payment_status SET DEFAULT 'pending';

-- Orders: container tables
ALTER TABLE public.patient_orders
  DROP CONSTRAINT IF EXISTS patient_orders_status_check,
  DROP CONSTRAINT IF EXISTS patient_orders_payment_status_check;
ALTER TABLE public.patient_orders
  ALTER COLUMN status TYPE public.patient_order_status_enum USING status::public.patient_order_status_enum,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN payment_status TYPE public.payment_status_enum USING payment_status::public.payment_status_enum,
  ALTER COLUMN payment_status SET DEFAULT 'unpaid';

ALTER TABLE public.patient_order_items
  DROP CONSTRAINT IF EXISTS patient_order_items_status_check;
ALTER TABLE public.patient_order_items
  ALTER COLUMN status TYPE public.patient_order_item_status_enum USING status::public.patient_order_item_status_enum,
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE public.rx_items
  DROP CONSTRAINT IF EXISTS rx_items_status_check;
ALTER TABLE public.rx_items
  ALTER COLUMN status TYPE public.rx_item_status_enum USING status::public.rx_item_status_enum,
  ALTER COLUMN status SET DEFAULT 'pending';

-- Orders: legacy tables
ALTER TABLE public.lab_orders
  DROP CONSTRAINT IF EXISTS lab_orders_status_check,
  DROP CONSTRAINT IF EXISTS lab_orders_payment_status_check;
ALTER TABLE public.lab_orders
  ALTER COLUMN status TYPE public.lab_order_status_enum USING status::public.lab_order_status_enum,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN payment_status TYPE public.payment_status_enum USING payment_status::public.payment_status_enum,
  ALTER COLUMN payment_status SET DEFAULT 'unpaid';

ALTER TABLE public.imaging_orders
  DROP CONSTRAINT IF EXISTS imaging_orders_status_check,
  DROP CONSTRAINT IF EXISTS imaging_orders_payment_status_check;
ALTER TABLE public.imaging_orders
  ALTER COLUMN status TYPE public.imaging_order_status_enum USING status::public.imaging_order_status_enum,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN payment_status TYPE public.payment_status_enum USING payment_status::public.payment_status_enum,
  ALTER COLUMN payment_status SET DEFAULT 'unpaid';

ALTER TABLE public.medication_orders
  DROP CONSTRAINT IF EXISTS medication_orders_status_check,
  DROP CONSTRAINT IF EXISTS medication_orders_payment_status_check;
ALTER TABLE public.medication_orders
  ALTER COLUMN status TYPE public.medication_order_status_enum USING status::public.medication_order_status_enum,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN payment_status TYPE public.payment_status_enum USING payment_status::public.payment_status_enum,
  ALTER COLUMN payment_status SET DEFAULT 'unpaid';

-- Billing and charges
ALTER TABLE public.billing_items
  ALTER COLUMN payment_status TYPE public.payment_status_enum USING payment_status::public.payment_status_enum,
  ALTER COLUMN payment_status SET DEFAULT 'unpaid';

ALTER TABLE public.ipd_charges
  DROP CONSTRAINT IF EXISTS ipd_charges_payment_status_check;
ALTER TABLE public.ipd_charges
  ALTER COLUMN payment_status TYPE public.payment_status_enum USING payment_status::public.payment_status_enum,
  ALTER COLUMN payment_status SET DEFAULT 'unpaid';

-- Inventory
ALTER TABLE public.request_for_resupply
  DROP CONSTRAINT IF EXISTS request_for_resupply_status_check;
ALTER TABLE public.request_for_resupply
  ALTER COLUMN status TYPE public.resupply_status_enum USING status::public.resupply_status_enum,
  ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE public.issue_orders
  DROP CONSTRAINT IF EXISTS issue_orders_status_check;
ALTER TABLE public.issue_orders
  ALTER COLUMN status TYPE public.issue_order_status_enum USING status::public.issue_order_status_enum,
  ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE public.receiving_invoices
  DROP CONSTRAINT IF EXISTS receiving_invoices_status_check;
ALTER TABLE public.receiving_invoices
  ALTER COLUMN status TYPE public.receiving_invoice_status_enum USING status::public.receiving_invoice_status_enum,
  ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE public.loss_adjustments
  DROP CONSTRAINT IF EXISTS loss_adjustments_status_check;
ALTER TABLE public.loss_adjustments
  ALTER COLUMN status TYPE public.loss_adjustment_status_enum USING status::public.loss_adjustment_status_enum,
  ALTER COLUMN status SET DEFAULT 'draft';

-- Admissions
ALTER TABLE public.beds
  DROP CONSTRAINT IF EXISTS beds_status_check;
ALTER TABLE public.beds
  ALTER COLUMN status TYPE public.bed_status_enum USING status::public.bed_status_enum,
  ALTER COLUMN status SET DEFAULT 'AVAILABLE';

ALTER TABLE public.admissions
  DROP CONSTRAINT IF EXISTS admissions_status_check;
ALTER TABLE public.admissions
  ALTER COLUMN status TYPE public.admission_status_enum USING status::public.admission_status_enum,
  ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE public.waitlist
  DROP CONSTRAINT IF EXISTS waitlist_status_check;
ALTER TABLE public.waitlist
  ALTER COLUMN status TYPE public.waitlist_status_enum USING status::public.waitlist_status_enum,
  ALTER COLUMN status SET DEFAULT 'waiting';

ALTER TABLE public.ipd_tasks
  DROP CONSTRAINT IF EXISTS ipd_tasks_status_check;
ALTER TABLE public.ipd_tasks
  ALTER COLUMN status TYPE public.ipd_task_status_enum USING status::public.ipd_task_status_enum,
  ALTER COLUMN status SET DEFAULT 'pending';
