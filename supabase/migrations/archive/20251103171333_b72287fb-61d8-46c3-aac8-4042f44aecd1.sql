-- Update get_medication_orders_with_patient to include payment fields
DROP FUNCTION IF EXISTS public.get_medication_orders_with_patient();

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
  patient_full_name text,
  patient_age integer,
  patient_gender text,
  prescriber_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
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
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender,
    u.name as prescriber_name
  FROM public.medication_orders mo
  JOIN public.patients p ON p.id = mo.patient_id
  LEFT JOIN public.users u ON u.id = mo.ordered_by
  WHERE EXISTS (
    SELECT 1
    FROM public.users usr
    WHERE usr.auth_user_id = auth.uid()
      AND usr.user_role = ANY(ARRAY['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'pharmacist'::user_role])
  )
  ORDER BY mo.ordered_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_medication_orders_with_patient() TO authenticated;