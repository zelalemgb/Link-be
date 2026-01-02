-- Create optimized function for getting patient visit counts
CREATE OR REPLACE FUNCTION public.get_patient_visit_counts(patient_ids UUID[])
RETURNS TABLE(patient_id UUID, visit_count BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    patient_id,
    COUNT(*)::BIGINT as visit_count
  FROM visits
  WHERE patient_id = ANY(patient_ids)
  GROUP BY patient_id;
$$;