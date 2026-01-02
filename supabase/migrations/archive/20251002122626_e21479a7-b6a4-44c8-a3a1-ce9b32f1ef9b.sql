-- Function to return medication orders with patient fields for pharmacists
create or replace function public.get_medication_orders_with_patient()
returns table (
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
  quantity int,
  refills int,
  status text,
  notes text,
  ordered_at timestamptz,
  dispensed_at timestamptz,
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
    p.full_name as patient_full_name,
    p.age as patient_age,
    p.gender as patient_gender
  from public.medication_orders mo
  join public.patients p on p.id = mo.patient_id
  where exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.user_role = any(array['doctor'::user_role,'clinical_officer'::user_role,'nurse'::user_role,'pharmacist'::user_role])
  )
  order by mo.ordered_at desc;
$$;

-- Grant execute permission
grant execute on function public.get_medication_orders_with_patient() to authenticated;