-- Drop the existing function first
DROP FUNCTION IF EXISTS public.get_lab_orders_with_patient();

-- Recreate the function with sample_type included
CREATE FUNCTION public.get_lab_orders_with_patient()
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
    p.gender as patient_gender,
    COALESCE(ltm.sample_type, 'Serum') as sample_type
  FROM public.lab_orders lo
  JOIN public.patients p ON p.id = lo.patient_id
  LEFT JOIN public.lab_test_master ltm ON ltm.test_code = lo.test_code
  WHERE EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.user_role = ANY(ARRAY['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'lab_technician'::user_role,'medical_director'::user_role])
  )
  ORDER BY lo.ordered_at DESC;
$function$;