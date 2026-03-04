-- ─── Staging fix 2: Tag a facility with AT shortcode 10727 ───────────────────
-- Run this AFTER staging_cleanup_1 (at_short_code column must exist first).
-- Run in Supabase SQL editor for the STAGING project.

-- Step 1: See which facilities exist so you can pick the right one
SELECT id, name, at_short_code
FROM public.facilities
ORDER BY created_at
LIMIT 20;

-- Step 2: Tag the FIRST facility (the one the SMS fallback already uses).
-- This replaces the fallback with a proper match so shortcode routing works.
-- If you want to tag a specific facility, replace the subquery with its UUID.
UPDATE public.facilities
SET at_short_code = '10727'
WHERE id = (
  SELECT id FROM public.facilities ORDER BY created_at LIMIT 1
)
  AND at_short_code IS NULL;  -- only update if not already tagged

-- Step 3: Verify
SELECT id, name, at_short_code
FROM public.facilities
WHERE at_short_code IS NOT NULL;

SELECT 'AT shortcode 10727 tagged ✓' AS result;
