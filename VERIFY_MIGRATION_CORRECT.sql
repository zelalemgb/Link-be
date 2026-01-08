-- ============================================================================
-- CORRECT VERIFICATION QUERY
-- Run this AFTER applying the migration to verify it worked
-- ============================================================================

-- Check the function parameters (correct query)
SELECT 
  p.parameter_name,
  p.data_type,
  p.ordinal_position
FROM information_schema.parameters p
WHERE p.specific_schema = 'public'
  AND p.specific_name IN (
    SELECT r.specific_name 
    FROM information_schema.routines r
    WHERE r.routine_schema = 'public' 
      AND r.routine_name = 'register_patient_with_visit'
  )
ORDER BY p.ordinal_position;

-- Expected: Should show 25 parameters including:
-- p_consultation_payment_type (text)
-- p_program_id (uuid)
-- p_creditor_id (uuid)
-- p_insurer_id (uuid)
-- p_insurance_policy_number (text)

-- ============================================================================
-- SIMPLER CHECK: Just count the parameters
-- ============================================================================

SELECT COUNT(*) as total_parameters
FROM information_schema.parameters p
WHERE p.specific_schema = 'public'
  AND p.specific_name IN (
    SELECT r.specific_name 
    FROM information_schema.routines r
    WHERE r.routine_schema = 'public' 
      AND r.routine_name = 'register_patient_with_visit'
  );

-- Expected result: 25
-- If you get 20 or less: Migration was NOT applied
-- If you get 25: Migration WAS applied ✅
