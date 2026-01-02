-- Ensure clinic registration workflow happens consistently
CREATE OR REPLACE FUNCTION public.register_clinic(
  p_auth_user_id uuid,
  p_clinic_name text,
  p_location text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_admin_name text DEFAULT NULL
)
RETURNS TABLE (facility_id uuid, clinic_code text, tenant_id uuid) AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_facility_id uuid;
  v_clinic_code text;
  v_normalized_clinic_name text := NULLIF(TRIM(p_clinic_name), '');
  v_normalized_admin_name text := NULLIF(TRIM(p_admin_name), '');
BEGIN
  IF v_normalized_clinic_name IS NULL THEN
    RAISE EXCEPTION 'Clinic name is required';
  END IF;

  SELECT id INTO v_user_id
  FROM public.users
  WHERE auth_user_id = p_auth_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User profile not found for the provided administrator account';
  END IF;

  IF EXISTS (SELECT 1 FROM public.facilities WHERE admin_user_id = v_user_id) THEN
    RAISE EXCEPTION 'This administrator is already linked to a clinic';
  END IF;

  IF EXISTS (SELECT 1 FROM public.facilities WHERE LOWER(name) = LOWER(v_normalized_clinic_name)) THEN
    RAISE EXCEPTION 'A clinic with this name already exists';
  END IF;

  UPDATE public.users
  SET
    name = COALESCE(v_normalized_admin_name, name),
    full_name = COALESCE(v_normalized_admin_name, full_name),
    user_role = 'admin',
    role = 'admin',
    verified = true,
    email_verified = true,
    updated_at = now()
  WHERE id = v_user_id;

  INSERT INTO public.tenants (name, is_active)
  VALUES (v_normalized_clinic_name, true)
  RETURNING id INTO v_tenant_id;

  INSERT INTO public.facilities (
    name,
    location,
    address,
    phone_number,
    email,
    admin_user_id,
    tenant_id,
    verification_status,
    verified,
    is_tester
  )
  VALUES (
    v_normalized_clinic_name,
    NULLIF(TRIM(p_location), ''),
    NULLIF(TRIM(p_address), ''),
    NULLIF(TRIM(p_phone), ''),
    NULLIF(TRIM(p_email), ''),
    v_user_id,
    v_tenant_id,
    'pending',
    false,
    true
  )
  RETURNING id, clinic_code INTO v_facility_id, v_clinic_code;

  UPDATE public.users
  SET
    facility_id = v_facility_id,
    tenant_id = v_tenant_id
  WHERE id = v_user_id;

  RETURN QUERY SELECT v_facility_id, v_clinic_code, v_tenant_id;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions;

GRANT EXECUTE ON FUNCTION public.register_clinic(uuid, text, text, text, text, text, text) TO authenticated, anon;
