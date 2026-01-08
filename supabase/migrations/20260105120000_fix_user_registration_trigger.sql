-- Update the handle_new_user function to extract facility_id and tenant_id from metadata
-- This ensures that users created via register-staff are correctly linked to their facility
-- even before their registration request is fully approved (or if they bypass pending check).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  meta_facility_id UUID;
  meta_tenant_id UUID;
  meta_role user_role;
BEGIN
  -- Extract values from metadata safely
  BEGIN
    meta_facility_id := (NEW.raw_user_meta_data->>'facility_id')::UUID;
  EXCEPTION WHEN OTHERS THEN
    meta_facility_id := NULL;
  END;

  BEGIN
    meta_tenant_id := (NEW.raw_user_meta_data->>'tenant_id')::UUID;
  EXCEPTION WHEN OTHERS THEN
    meta_tenant_id := NULL;
  END;

  -- Default role to receptionist if not specified or invalid
  BEGIN
    meta_role := (NEW.raw_user_meta_data->>'user_role')::user_role;
  EXCEPTION WHEN OTHERS THEN
    meta_role := 'receptionist'::user_role;
  END;

  INSERT INTO public.users (
    auth_user_id, 
    full_name, 
    phone, 
    role, 
    facility_id, 
    tenant_id
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', 'New User'),
    COALESCE(NEW.phone, NEW.raw_user_meta_data->>'phone', ''),
    COALESCE(meta_role, 'receptionist'::user_role),
    meta_facility_id,
    meta_tenant_id
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
