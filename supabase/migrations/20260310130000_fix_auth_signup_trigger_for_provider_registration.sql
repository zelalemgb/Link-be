-- Fix auth signup trigger so solo-provider signups do not fail with:
-- "Database error saving new user".
--
-- Root cause:
-- Previous trigger variants could write raw `user_role` values directly into
-- `public.users.role` (app_role), which breaks for values like `doctor`.
--
-- This version:
-- - Safely parses metadata UUIDs/enums
-- - Maps user_role -> app_role when `role` metadata is absent/invalid
-- - Persists facility_id/tenant_id metadata when present
-- - Preserves existing profile linkage on conflict updates

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  default_tenant_id constant uuid := '00000000-0000-0000-0000-000000000001';
  meta_facility_id uuid;
  meta_tenant_id uuid;
  resolved_full_name text;
  resolved_phone text;
  resolved_user_role public.user_role;
  resolved_app_role public.app_role;
BEGIN
  resolved_full_name := COALESCE(
    NULLIF(BTRIM(NEW.raw_user_meta_data->>'full_name'), ''),
    NULLIF(BTRIM(NEW.raw_user_meta_data->>'name'), ''),
    'New User'
  );

  resolved_phone := NULLIF(
    BTRIM(COALESCE(
      NEW.phone,
      NEW.raw_user_meta_data->>'phone_number',
      NEW.raw_user_meta_data->>'phone',
      ''
    )),
    ''
  );

  BEGIN
    meta_facility_id := NULLIF(NEW.raw_user_meta_data->>'facility_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    meta_facility_id := NULL;
  END;

  BEGIN
    meta_tenant_id := NULLIF(NEW.raw_user_meta_data->>'tenant_id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    meta_tenant_id := NULL;
  END;

  IF meta_tenant_id IS NULL AND meta_facility_id IS NOT NULL THEN
    SELECT tenant_id INTO meta_tenant_id
    FROM public.facilities
    WHERE id = meta_facility_id
    LIMIT 1;
  END IF;

  BEGIN
    resolved_user_role := NULLIF(NEW.raw_user_meta_data->>'user_role', '')::public.user_role;
  EXCEPTION WHEN OTHERS THEN
    resolved_user_role := NULL;
  END;

  IF resolved_user_role IS NULL THEN
    resolved_user_role := CASE lower(COALESCE(NEW.raw_user_meta_data->>'role', ''))
      WHEN 'admin' THEN 'admin'::public.user_role
      WHEN 'provider' THEN 'doctor'::public.user_role
      ELSE 'receptionist'::public.user_role
    END;
  END IF;

  BEGIN
    resolved_app_role := NULLIF(NEW.raw_user_meta_data->>'role', '')::public.app_role;
  EXCEPTION WHEN OTHERS THEN
    resolved_app_role := NULL;
  END;

  IF resolved_app_role IS NULL THEN
    resolved_app_role := CASE resolved_user_role
      WHEN 'admin'::public.user_role THEN 'admin'::public.app_role
      WHEN 'super_admin'::public.user_role THEN 'admin'::public.app_role
      ELSE 'provider'::public.app_role
    END;
  END IF;

  INSERT INTO public.users (
    auth_user_id,
    full_name,
    name,
    phone_number,
    role,
    user_role,
    facility_id,
    tenant_id,
    email_verified,
    verified
  )
  VALUES (
    NEW.id,
    resolved_full_name,
    resolved_full_name,
    resolved_phone,
    resolved_app_role,
    resolved_user_role,
    meta_facility_id,
    COALESCE(meta_tenant_id, default_tenant_id),
    NEW.email_confirmed_at IS NOT NULL,
    false
  )
  ON CONFLICT (auth_user_id) DO UPDATE
  SET
    full_name = EXCLUDED.full_name,
    name = EXCLUDED.name,
    phone_number = EXCLUDED.phone_number,
    role = EXCLUDED.role,
    user_role = EXCLUDED.user_role,
    facility_id = COALESCE(EXCLUDED.facility_id, public.users.facility_id),
    tenant_id = COALESCE(EXCLUDED.tenant_id, public.users.tenant_id),
    email_verified = EXCLUDED.email_verified,
    verified = EXCLUDED.verified,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
