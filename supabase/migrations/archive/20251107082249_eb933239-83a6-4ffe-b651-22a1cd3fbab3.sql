-- Fix lab orders RPC to show all orders for facility staff
CREATE OR REPLACE FUNCTION public.get_lab_orders_with_patient()
RETURNS TABLE(
  id uuid, visit_id uuid, patient_id uuid, ordered_by uuid,
  test_name text, test_code text, urgency text, status text,
  result text, result_value text, reference_range text, notes text,
  ordered_at timestamp with time zone, collected_at timestamp with time zone,
  completed_at timestamp with time zone, created_at timestamp with time zone,
  updated_at timestamp with time zone, payment_status text, payment_mode text,
  amount numeric, paid_at timestamp with time zone,
  patient_full_name text, patient_age integer, patient_gender text, sample_type text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    lo.id, lo.visit_id, lo.patient_id, lo.ordered_by,
    lo.test_name, lo.test_code, lo.urgency, lo.status,
    lo.result, lo.result_value, lo.reference_range, lo.notes,
    lo.ordered_at, lo.collected_at, lo.completed_at,
    lo.created_at, lo.updated_at,
    lo.payment_status, lo.payment_mode, lo.amount, lo.paid_at,
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender,
    COALESCE(ltm.sample_type, 'Serum') as sample_type
  FROM public.lab_orders lo
  JOIN public.patients p ON p.id = lo.patient_id
  JOIN public.visits v ON v.id = lo.visit_id
  LEFT JOIN public.lab_test_master ltm ON ltm.test_code = lo.test_code
  WHERE (
    v.facility_id = public.get_user_facility_id()
    OR public.is_super_admin()
  )
  -- Removed restrictive role check - rely on RLS policies instead
  ORDER BY lo.ordered_at DESC;
$$;

-- Fix imaging orders RPC to show all orders for facility staff
CREATE OR REPLACE FUNCTION public.get_imaging_orders_with_patient()
RETURNS TABLE(
  id uuid, visit_id uuid, patient_id uuid, ordered_by uuid,
  study_name text, study_code text, body_part text,
  urgency text, status text, result text, findings text,
  impression text, notes text,
  ordered_at timestamp with time zone, scheduled_at timestamp with time zone,
  completed_at timestamp with time zone, created_at timestamp with time zone,
  updated_at timestamp with time zone, payment_status text, payment_mode text,
  amount numeric, paid_at timestamp with time zone,
  patient_full_name text, patient_age integer, patient_gender text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    io.id, io.visit_id, io.patient_id, io.ordered_by,
    io.study_name, io.study_code, io.body_part,
    io.urgency, io.status, io.result, io.findings,
    io.impression, io.notes,
    io.ordered_at, io.scheduled_at, io.completed_at,
    io.created_at, io.updated_at,
    io.payment_status, io.payment_mode, io.amount, io.paid_at,
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender
  FROM public.imaging_orders io
  JOIN public.patients p ON p.id = io.patient_id
  JOIN public.visits v ON v.id = io.visit_id
  WHERE (
    v.facility_id = public.get_user_facility_id()
    OR public.is_super_admin()
  )
  -- Removed restrictive role check - rely on RLS policies instead
  ORDER BY io.ordered_at DESC;
$$;