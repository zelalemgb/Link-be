-- Create a helper RPC to resolve patient info for visits with proper facility scoping
CREATE OR REPLACE FUNCTION public.get_visit_patient_info(visit_ids uuid[])
RETURNS TABLE(
  visit_id uuid,
  patient_id uuid,
  full_name text,
  age integer,
  gender text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT 
    v.id AS visit_id,
    p.id AS patient_id,
    p.full_name,
    p.age,
    p.gender
  FROM public.visits v
  JOIN public.patients p ON p.id = v.patient_id
  WHERE v.id = ANY(visit_ids)
    AND (
      v.facility_id = public.get_user_facility_id()
      OR public.is_super_admin()
    );
$$;