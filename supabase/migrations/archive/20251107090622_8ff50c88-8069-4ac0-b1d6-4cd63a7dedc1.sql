-- Fix security: Add search_path to function
DROP FUNCTION IF EXISTS public.get_patient_visit_counts(UUID[]);

CREATE OR REPLACE FUNCTION public.get_patient_visit_counts(patient_ids UUID[])
RETURNS TABLE(patient_id UUID, visit_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    v.patient_id,
    COUNT(*)::BIGINT AS visit_count
  FROM public.visits v
  WHERE v.patient_id = ANY(patient_ids)
    AND v.tenant_id = get_user_tenant_id()
    AND (
      v.facility_id = get_user_facility_id()
      OR is_super_admin()
    )
  GROUP BY v.patient_id;
$$;