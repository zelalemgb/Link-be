-- Create the register_clinic RPC function
CREATE OR REPLACE FUNCTION public.register_clinic(
  p_auth_user_id UUID,
  p_clinic_name TEXT,
  p_location TEXT,
  p_address TEXT,
  p_phone TEXT,
  p_email TEXT,
  p_admin_name TEXT
)
RETURNS TABLE(facility_id UUID, clinic_code TEXT, tenant_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_facility_id UUID;
  v_clinic_code TEXT;
  v_user_id UUID;
BEGIN
  -- Generate unique clinic code
  v_clinic_code := 'CLI-' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 8));
  
  -- Create tenant
  INSERT INTO tenants (name, type, status, created_at, updated_at)
  VALUES (p_clinic_name, 'clinic', 'active', NOW(), NOW())
  RETURNING id INTO v_tenant_id;
  
  -- Create facility
  INSERT INTO facilities (
    tenant_id,
    name,
    facility_type,
    location,
    address,
    phone,
    email,
    clinic_code,
    status,
    created_at,
    updated_at
  ) VALUES (
    v_tenant_id,
    p_clinic_name,
    'clinic',
    p_location,
    p_address,
    p_phone,
    p_email,
    v_clinic_code,
    'active',
    NOW(),
    NOW()
  )
  RETURNING id INTO v_facility_id;
  
  -- Get or create user record in public.users
  SELECT id INTO v_user_id
  FROM users
  WHERE auth_user_id = p_auth_user_id;
  
  IF v_user_id IS NULL THEN
    INSERT INTO users (
      auth_user_id,
      full_name,
      email,
      user_role,
      tenant_id,
      facility_id,
      status,
      created_at,
      updated_at
    ) VALUES (
      p_auth_user_id,
      p_admin_name,
      (SELECT email FROM auth.users WHERE id = p_auth_user_id),
      'admin',
      v_tenant_id,
      v_facility_id,
      'active',
      NOW(),
      NOW()
    )
    RETURNING id INTO v_user_id;
  ELSE
    -- Update existing user with facility info
    UPDATE users
    SET
      tenant_id = v_tenant_id,
      facility_id = v_facility_id,
      user_role = 'admin',
      full_name = p_admin_name,
      status = 'active',
      updated_at = NOW()
    WHERE id = v_user_id;
  END IF;
  
  -- Return the facility information
  RETURN QUERY
  SELECT v_facility_id, v_clinic_code, v_tenant_id;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.register_clinic TO authenticated;