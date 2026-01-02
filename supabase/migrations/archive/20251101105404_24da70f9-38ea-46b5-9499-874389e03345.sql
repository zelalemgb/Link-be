-- Add payment tracking columns to lab_orders
ALTER TABLE public.lab_orders 
ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid',
ADD COLUMN IF NOT EXISTS payment_mode text,
ADD COLUMN IF NOT EXISTS amount numeric,
ADD COLUMN IF NOT EXISTS paid_at timestamp with time zone;

-- Add check constraint for lab_orders payment_status
ALTER TABLE public.lab_orders
DROP CONSTRAINT IF EXISTS lab_orders_payment_status_check;

ALTER TABLE public.lab_orders
ADD CONSTRAINT lab_orders_payment_status_check 
CHECK (payment_status IN ('paid', 'unpaid'));

-- Add check constraint for lab_orders payment_mode
ALTER TABLE public.lab_orders
DROP CONSTRAINT IF EXISTS lab_orders_payment_mode_check;

ALTER TABLE public.lab_orders
ADD CONSTRAINT lab_orders_payment_mode_check 
CHECK (payment_mode IS NULL OR payment_mode IN ('cash', 'free', 'insurance', 'credit'));

-- Add payment tracking columns to imaging_orders
ALTER TABLE public.imaging_orders 
ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid',
ADD COLUMN IF NOT EXISTS payment_mode text,
ADD COLUMN IF NOT EXISTS amount numeric,
ADD COLUMN IF NOT EXISTS paid_at timestamp with time zone;

-- Add check constraint for imaging_orders payment_status
ALTER TABLE public.imaging_orders
DROP CONSTRAINT IF EXISTS imaging_orders_payment_status_check;

ALTER TABLE public.imaging_orders
ADD CONSTRAINT imaging_orders_payment_status_check 
CHECK (payment_status IN ('paid', 'unpaid'));

-- Add check constraint for imaging_orders payment_mode
ALTER TABLE public.imaging_orders
DROP CONSTRAINT IF EXISTS imaging_orders_payment_mode_check;

ALTER TABLE public.imaging_orders
ADD CONSTRAINT imaging_orders_payment_mode_check 
CHECK (payment_mode IS NULL OR payment_mode IN ('cash', 'free', 'insurance', 'credit'));

-- Create indexes for payment queries
CREATE INDEX IF NOT EXISTS idx_lab_orders_payment_status ON public.lab_orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_imaging_orders_payment_status ON public.imaging_orders(payment_status);

-- Drop and recreate get_lab_orders_with_patient function with payment fields
DROP FUNCTION IF EXISTS public.get_lab_orders_with_patient();

CREATE OR REPLACE FUNCTION public.get_lab_orders_with_patient()
RETURNS TABLE(
  id uuid,
  visit_id uuid,
  patient_id uuid,
  ordered_by uuid,
  test_name text,
  test_code text,
  urgency text,
  status text,
  result text,
  result_value text,
  reference_range text,
  notes text,
  ordered_at timestamp with time zone,
  collected_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  payment_status text,
  payment_mode text,
  amount numeric,
  paid_at timestamp with time zone,
  patient_full_name text,
  patient_age integer,
  patient_gender text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    lo.id,
    lo.visit_id,
    lo.patient_id,
    lo.ordered_by,
    lo.test_name,
    lo.test_code,
    lo.urgency,
    lo.status,
    lo.result,
    lo.result_value,
    lo.reference_range,
    lo.notes,
    lo.ordered_at,
    lo.collected_at,
    lo.completed_at,
    lo.created_at,
    lo.updated_at,
    lo.payment_status,
    lo.payment_mode,
    lo.amount,
    lo.paid_at,
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender
  FROM public.lab_orders lo
  JOIN public.patients p ON p.id = lo.patient_id
  WHERE EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = ANY(ARRAY['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'lab_technician'::user_role])
  )
  ORDER BY lo.ordered_at DESC;
$function$;

-- Drop and recreate get_imaging_orders_with_patient function with payment fields
DROP FUNCTION IF EXISTS public.get_imaging_orders_with_patient();

CREATE OR REPLACE FUNCTION public.get_imaging_orders_with_patient()
RETURNS TABLE(
  id uuid,
  visit_id uuid,
  patient_id uuid,
  ordered_by uuid,
  study_name text,
  study_code text,
  body_part text,
  urgency text,
  status text,
  result text,
  findings text,
  impression text,
  notes text,
  ordered_at timestamp with time zone,
  scheduled_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  payment_status text,
  payment_mode text,
  amount numeric,
  paid_at timestamp with time zone,
  patient_full_name text,
  patient_age integer,
  patient_gender text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    io.id,
    io.visit_id,
    io.patient_id,
    io.ordered_by,
    io.study_name,
    io.study_code,
    io.body_part,
    io.urgency,
    io.status,
    io.result,
    io.findings,
    io.impression,
    io.notes,
    io.ordered_at,
    io.scheduled_at,
    io.completed_at,
    io.created_at,
    io.updated_at,
    io.payment_status,
    io.payment_mode,
    io.amount,
    io.paid_at,
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender
  FROM public.imaging_orders io
  JOIN public.patients p ON p.id = io.patient_id
  WHERE EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = ANY(ARRAY['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'imaging_technician'::user_role,'radiologist'::user_role])
  )
  ORDER BY io.ordered_at DESC;
$function$;