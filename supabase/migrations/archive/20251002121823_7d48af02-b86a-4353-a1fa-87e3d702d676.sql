-- Function to return lab orders with minimal patient fields, restricted to medical staff
create or replace function public.get_lab_orders_with_patient()
returns table (
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
  ordered_at timestamptz,
  collected_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  patient_full_name text,
  patient_age int,
  patient_gender text
)
language sql
stable
security definer
set search_path = public
as $$
  select
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
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender
  from public.lab_orders lo
  join public.patients p on p.id = lo.patient_id
  where exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.user_role = any(array['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'lab_technician'::user_role])
  )
  order by lo.ordered_at desc;
$$;

-- Ensure authenticated clients can call the function
grant execute on function public.get_lab_orders_with_patient() to authenticated;