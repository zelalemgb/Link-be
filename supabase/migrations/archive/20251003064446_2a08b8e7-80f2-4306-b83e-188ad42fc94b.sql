-- Create function to fetch imaging orders with patient info for authorized medical staff
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
  patient_full_name text,
  patient_age integer,
  patient_gender text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select
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
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender
  from public.imaging_orders io
  join public.patients p on p.id = io.patient_id
  where exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.user_role = any(array['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'imaging_technician'::user_role,'radiologist'::user_role])
  )
  order by io.ordered_at desc;
$function$;