-- Fix signup blocker: handle_new_user() uses ON CONFLICT (auth_user_id),
-- but public.users.auth_user_id has no usable unique constraint.
--
-- We cannot delete duplicate rows directly because they are referenced by
-- clinical records. Instead we keep the highest-priority row per auth_user_id
-- and detach older duplicates by nulling auth_user_id.
--
-- Postgres UNIQUE allows multiple NULLs, so this safely enables a unique
-- constraint on auth_user_id while preserving historical references.

WITH ranked AS (
  SELECT
    id,
    auth_user_id,
    ROW_NUMBER() OVER (
      PARTITION BY auth_user_id
      ORDER BY
        (facility_id IS NOT NULL) DESC,
        (tenant_id IS NOT NULL) DESC,
        COALESCE(updated_at, created_at) DESC,
        created_at DESC,
        id DESC
    ) AS rn
  FROM public.users
  WHERE auth_user_id IS NOT NULL
)
UPDATE public.users u
SET
  auth_user_id = NULL,
  updated_at = now()
FROM ranked r
WHERE u.id = r.id
  AND r.rn > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_auth_user_id_key'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_user_id_key UNIQUE (auth_user_id);
  END IF;
END
$$;
