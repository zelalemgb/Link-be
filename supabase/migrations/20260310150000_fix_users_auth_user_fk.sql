-- Fix broken FK on public.users.auth_user_id that blocks Auth signups.
-- Expected: public.users.auth_user_id -> auth.users(id)
-- Observed in production: users_auth_user_id_fkey points to public.users, causing
-- "Database error saving new user" when the signup trigger inserts NEW.id.

DO $$
DECLARE
  v_points_to_auth boolean := false;
BEGIN
  SELECT
    (n.nspname = 'auth' AND c.relname = 'users')
  INTO v_points_to_auth
  FROM pg_constraint co
  JOIN pg_class c ON c.oid = co.confrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE co.conname = 'users_auth_user_id_fkey'
    AND co.conrelid = 'public.users'::regclass
    AND co.contype = 'f'
  LIMIT 1;

  IF v_points_to_auth IS DISTINCT FROM true THEN
    ALTER TABLE public.users
      DROP CONSTRAINT IF EXISTS users_auth_user_id_fkey;

    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_user_id_fkey
      FOREIGN KEY (auth_user_id)
      REFERENCES auth.users(id)
      ON DELETE SET NULL;
  END IF;
END
$$;
