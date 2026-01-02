-- Manual fix for existing user with missing facility_id
-- This user registered before the fix was in place
UPDATE public.users u
SET facility_id = 'b851c4ea-3760-4653-97c2-7d935622b036'::uuid,
    user_role = 'doctor',
    updated_at = now()
WHERE u.auth_user_id = '97739af5-bbcf-4fbb-a6b4-b34105fa9752'::uuid
  AND u.facility_id IS NULL;