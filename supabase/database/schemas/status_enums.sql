-- Shared status enums used across finance, clinical orders, inventory, and admissions
-- These definitions centralize the allowed values so table constraints can reference
-- a single canonical source.

CREATE TYPE IF NOT EXISTS public.payment_status_enum AS ENUM (
  'pending',
  'unpaid',
  'partial',
  'paid',
  'cancelled',
  'refunded',
  'waived',
  'disputed'
);

CREATE TYPE IF NOT EXISTS public.patient_order_status_enum AS ENUM (
  'pending',
  'approved',
  'in_progress',
  'completed',
  'cancelled',
  'discontinued'
);

CREATE TYPE IF NOT EXISTS public.patient_order_item_status_enum AS ENUM (
  'pending',
  'collected',
  'in_progress',
  'completed',
  'cancelled'
);

CREATE TYPE IF NOT EXISTS public.lab_order_status_enum AS ENUM (
  'pending',
  'collected',
  'processing',
  'completed',
  'cancelled',
  'rejected'
);

CREATE TYPE IF NOT EXISTS public.imaging_order_status_enum AS ENUM (
  'pending',
  'scheduled',
  'in_progress',
  'completed',
  'cancelled'
);

CREATE TYPE IF NOT EXISTS public.medication_order_status_enum AS ENUM (
  'pending',
  'dispensed',
  'administered',
  'discontinued',
  'cancelled'
);

CREATE TYPE IF NOT EXISTS public.rx_item_status_enum AS ENUM (
  'pending',
  'dispensed',
  'partially_dispensed',
  'cancelled',
  'discontinued'
);

CREATE TYPE IF NOT EXISTS public.resupply_status_enum AS ENUM (
  'draft',
  'submitted',
  'verified',
  'approved',
  'cancelled'
);

CREATE TYPE IF NOT EXISTS public.issue_order_status_enum AS ENUM (
  'draft',
  'pending',
  'issued',
  'cancelled'
);

CREATE TYPE IF NOT EXISTS public.receiving_invoice_status_enum AS ENUM (
  'draft',
  'submitted',
  'invoiced',
  'cancelled',
  'voided'
);

CREATE TYPE IF NOT EXISTS public.loss_adjustment_status_enum AS ENUM (
  'draft',
  'submitted',
  'approved',
  'rejected'
);

CREATE TYPE IF NOT EXISTS public.bed_status_enum AS ENUM (
  'AVAILABLE',
  'OCCUPIED',
  'CLEANING',
  'MAINTENANCE',
  'RESERVED',
  'BLOCKED'
);

CREATE TYPE IF NOT EXISTS public.admission_status_enum AS ENUM (
  'active',
  'discharged',
  'transferred_out',
  'absconded',
  'deceased',
  'cancelled'
);

CREATE TYPE IF NOT EXISTS public.waitlist_status_enum AS ENUM (
  'waiting',
  'notified',
  'admitted',
  'cancelled',
  'expired'
);

CREATE TYPE IF NOT EXISTS public.ipd_task_status_enum AS ENUM (
  'pending',
  'in_progress',
  'completed',
  'skipped',
  'cancelled'
);
