-- Remove insecure create_user_without_auth helper
DROP FUNCTION IF EXISTS public.create_user_without_auth(text, text, text, text, uuid);
