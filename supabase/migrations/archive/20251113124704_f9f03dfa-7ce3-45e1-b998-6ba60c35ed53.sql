-- Remove all non-super-admin users from public.users and auth.users
-- This ensures a clean slate for the new clinic-based registration model

-- Step 1: Delete all non-super-admin users from public.users
DELETE FROM public.users 
WHERE user_role != 'super_admin';

-- Step 2: Delete corresponding auth users (except super admins)
-- We need to use a DO block since we can't directly delete from auth.users in regular SQL
DO $$
DECLARE
  auth_user_record RECORD;
BEGIN
  -- Find all auth users that don't have a super_admin profile
  FOR auth_user_record IN 
    SELECT au.id 
    FROM auth.users au
    LEFT JOIN public.users u ON au.id = u.auth_user_id AND u.user_role = 'super_admin'
    WHERE u.id IS NULL
  LOOP
    -- Delete each non-super-admin auth user
    DELETE FROM auth.users WHERE id = auth_user_record.id;
  END LOOP;
END $$;

-- Step 3: Update handle_staff_user_creation trigger to REQUIRE facility association
-- (except for super admins)
CREATE OR REPLACE FUNCTION public.handle_staff_user_creation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  facility_record facilities%ROWTYPE;
  clinic_code_from_metadata text;
  facility_id_from_metadata text;
  user_role_from_metadata text;
BEGIN
  -- Get user role from metadata
  user_role_from_metadata := COALESCE(
    NEW.raw_user_meta_data ->> 'user_role',
    NEW.raw_user_meta_data ->> 'role',
    'receptionist'
  );
  
  -- Super admins don't need facility association
  IF user_role_from_metadata = 'super_admin' THEN
    INSERT INTO public.users (auth_user_id, name, user_role, verified)
    VALUES (
      NEW.id, 
      COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name', ''),
      'super_admin'::public.user_role,
      true
    );
    RETURN NEW;
  END IF;
  
  -- Get facility_id from user metadata (for invitation-based signup)
  facility_id_from_metadata := NEW.raw_user_meta_data ->> 'facility_id';
  
  -- If facility_id is provided directly, use it
  IF facility_id_from_metadata IS NOT NULL THEN
    INSERT INTO public.users (auth_user_id, name, user_role, facility_id, verified)
    VALUES (
      NEW.id, 
      COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name', ''),
      user_role_from_metadata::public.user_role,
      facility_id_from_metadata::uuid,
      true
    );
    RETURN NEW;
  END IF;
  
  -- Try clinic code lookup
  clinic_code_from_metadata := NEW.raw_user_meta_data ->> 'clinic_code';
  
  IF clinic_code_from_metadata IS NOT NULL THEN
    SELECT * INTO facility_record 
    FROM public.facilities 
    WHERE clinic_code = clinic_code_from_metadata 
    LIMIT 1;
    
    IF facility_record.id IS NOT NULL THEN
      INSERT INTO public.users (auth_user_id, name, user_role, facility_id, verified)
      VALUES (
        NEW.id, 
        COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name', ''),
        user_role_from_metadata::public.user_role,
        facility_record.id,
        true
      );
      RETURN NEW;
    END IF;
  END IF;
  
  -- CRITICAL: If we reach here, no facility was provided and user is not super admin
  -- Block the registration by raising an exception
  RAISE EXCEPTION 'User registration requires facility association. Please register through a clinic or provide a valid clinic code.';
  
END;
$function$;

-- Step 4: Add a validation comment
COMMENT ON FUNCTION public.handle_staff_user_creation() IS 
'Trigger function that creates public.users records when auth.users are created. 
Requires facility_id or clinic_code in metadata for all users except super_admin role.';
