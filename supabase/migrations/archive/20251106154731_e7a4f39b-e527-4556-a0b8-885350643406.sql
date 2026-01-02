-- Fix security definer functions to enforce facility-based data isolation
-- These functions bypass RLS, so we must add facility filtering directly

-- ============================================
-- FIX: get_lab_orders_with_patient
-- ============================================
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
  patient_gender text,
  sample_type text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
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
    p.gender as patient_gender,
    COALESCE(ltm.sample_type, 'Serum') as sample_type
  FROM public.lab_orders lo
  JOIN public.patients p ON p.id = lo.patient_id
  JOIN public.visits v ON v.id = lo.visit_id
  LEFT JOIN public.lab_test_master ltm ON ltm.test_code = lo.test_code
  WHERE (
    -- CRITICAL: Enforce facility isolation
    v.facility_id = public.get_user_facility_id()
    OR public.is_super_admin()
  )
  AND EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = ANY(ARRAY['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'lab_technician'::user_role,'medical_director'::user_role])
  )
  ORDER BY lo.ordered_at DESC;
$function$;

COMMENT ON FUNCTION public.get_lab_orders_with_patient() IS 
'SECURITY DEFINER function with facility isolation. Only returns lab orders from the user''s facility or for super admins.';

-- ============================================
-- FIX: get_imaging_orders_with_patient
-- ============================================
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
STABLE SECURITY DEFINER
SET search_path = public
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
  JOIN public.visits v ON v.id = io.visit_id
  WHERE (
    -- CRITICAL: Enforce facility isolation
    v.facility_id = public.get_user_facility_id()
    OR public.is_super_admin()
  )
  AND EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = ANY(ARRAY['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'imaging_technician'::user_role,'radiologist'::user_role])
  )
  ORDER BY io.ordered_at DESC;
$function$;

COMMENT ON FUNCTION public.get_imaging_orders_with_patient() IS 
'SECURITY DEFINER function with facility isolation. Only returns imaging orders from the user''s facility or for super admins.';

-- ============================================
-- FIX: get_medication_orders_with_patient
-- ============================================
CREATE OR REPLACE FUNCTION public.get_medication_orders_with_patient()
RETURNS TABLE(
  id uuid,
  visit_id uuid,
  patient_id uuid,
  ordered_by uuid,
  medication_name text,
  generic_name text,
  dosage text,
  frequency text,
  route text,
  duration text,
  quantity integer,
  refills integer,
  status text,
  notes text,
  ordered_at timestamp with time zone,
  dispensed_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  payment_status text,
  payment_mode text,
  amount numeric,
  paid_at timestamp with time zone,
  sent_outside boolean,
  patient_full_name text,
  patient_age integer,
  patient_gender text,
  prescriber_name text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    mo.id,
    mo.visit_id,
    mo.patient_id,
    mo.ordered_by,
    mo.medication_name,
    mo.generic_name,
    mo.dosage,
    mo.frequency,
    mo.route,
    mo.duration,
    mo.quantity,
    mo.refills,
    mo.status,
    mo.notes,
    mo.ordered_at,
    mo.dispensed_at,
    mo.created_at,
    mo.updated_at,
    mo.payment_status,
    mo.payment_mode,
    mo.amount,
    mo.paid_at,
    mo.sent_outside,
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender,
    u.name as prescriber_name
  FROM public.medication_orders mo
  JOIN public.patients p ON p.id = mo.patient_id
  JOIN public.visits v ON v.id = mo.visit_id
  LEFT JOIN public.users u ON u.id = mo.ordered_by
  WHERE (
    -- CRITICAL: Enforce facility isolation
    v.facility_id = public.get_user_facility_id()
    OR public.is_super_admin()
  )
  AND EXISTS (
    SELECT 1
    FROM public.users usr
    WHERE usr.auth_user_id = auth.uid()
      AND usr.user_role = ANY(ARRAY['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'pharmacist'::user_role])
  )
  ORDER BY mo.ordered_at DESC;
$function$;

COMMENT ON FUNCTION public.get_medication_orders_with_patient() IS 
'SECURITY DEFINER function with facility isolation. Only returns medication orders from the user''s facility or for super admins.';