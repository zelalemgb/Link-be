-- ============================================================================
-- VERIFICATION SCRIPT
-- Run this in Supabase SQL Editor to check if migrations were applied
-- ============================================================================

-- 1. Check if last_login_at column exists
SELECT 
  column_name, 
  data_type,
  is_nullable
FROM information_schema.columns 
WHERE table_schema = 'public'
  AND table_name = 'users' 
  AND column_name = 'last_login_at';

-- Expected result: Should return 1 row showing the column exists
-- If no rows: Migration 1 was NOT applied

-- ============================================================================

-- 2. Check register_patient_with_visit function parameters
SELECT 
  routine_name,
  string_agg(parameter_name || ' ' || data_type, ', ' ORDER BY ordinal_position) as parameters
FROM information_schema.parameters
WHERE specific_schema = 'public'
  AND routine_name = 'register_patient_with_visit'
GROUP BY routine_name;

-- Expected result: Should show parameters including:
-- p_consultation_payment_type, p_program_id, p_creditor_id, p_insurer_id, p_insurance_policy_number
-- If these are missing: Migration 2 was NOT applied

-- ============================================================================

-- 3. Count users with last_login_at set (should be all existing users after backfill)
SELECT 
  COUNT(*) as total_users,
  COUNT(last_login_at) as users_with_login_time,
  COUNT(*) - COUNT(last_login_at) as users_without_login_time
FROM public.users;

-- Expected result: users_without_login_time should be 0 (all backfilled)

-- ============================================================================

-- 4. Test function call (will fail but shows if signature is correct)
-- Uncomment to test:
/*
SELECT register_patient_with_visit(
  'Test', 'Test', 'Test', 'Male', 30, '1994-01-01'::date,
  '+251900000000', NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  NULL, NULL, NULL, NULL, NULL,
  'New', NULL, NULL, NULL, NULL,
  'paying', NULL, NULL, NULL, NULL
);
*/
-- If you get "function does not exist" error: Migration 2 was NOT applied
-- If you get "Tenant ID not found" or other error: Migration 2 WAS applied (signature is correct)
