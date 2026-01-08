-- Check which versions of register_patient_with_visit exist
SELECT 
  r.routine_name,
  r.specific_name,
  COUNT(p.parameter_name) as param_count,
  string_agg(p.parameter_name, ', ' ORDER BY p.ordinal_position) as parameters
FROM information_schema.routines r
LEFT JOIN information_schema.parameters p 
  ON r.specific_name = p.specific_name 
  AND r.specific_schema = p.specific_schema
WHERE r.routine_schema = 'public' 
  AND r.routine_name = 'register_patient_with_visit'
GROUP BY r.routine_name, r.specific_name
ORDER BY param_count DESC;

-- This will show all versions and their parameter counts
-- Look for the one with 25 parameters that includes:
-- p_consultation_payment_type, p_program_id, p_creditor_id, p_insurer_id, p_insurance_policy_number
