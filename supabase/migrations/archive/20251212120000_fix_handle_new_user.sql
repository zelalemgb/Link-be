-- Ensure new auth signups create compatible user profiles for clinic registration
DROP FUNCTION IF EXISTS public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  default_tenant_id constant uuid := '00000000-0000-0000-0000-000000000001';
  resolved_full_name text;
  resolved_phone text;
  resolved_user_role public.user_role;
  resolved_app_role public.app_role;
BEGIN
  resolved_full_name := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
    NULLIF(NEW.raw_user_meta_data->>'name', ''),
    'New User'
  );

  resolved_phone := NULLIF(
    COALESCE(NEW.phone, NEW.raw_user_meta_data->>'phone', ''),
    ''
  );

  resolved_user_role := COALESCE(
    (NEW.raw_user_meta_data->>'user_role')::public.user_role,
    'receptionist'
  );

  resolved_app_role := COALESCE(
    (NEW.raw_user_meta_data->>'role')::public.app_role,
    CASE resolved_user_role
      WHEN 'admin' THEN 'admin'
      WHEN 'super_admin' THEN 'admin'
      ELSE 'provider'
    END
  );

  INSERT INTO public.users (
    auth_user_id,
    full_name,
    name,
    phone_number,
    role,
    user_role,
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
    default_tenant_id,
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
    tenant_id = EXCLUDED.tenant_id,
    email_verified = EXCLUDED.email_verified,
    verified = EXCLUDED.verified,
    updated_at = now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate trigger to make sure it points to the refreshed implementation
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
