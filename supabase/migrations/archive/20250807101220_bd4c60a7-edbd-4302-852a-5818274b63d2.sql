-- COMPLETE REMAINING FUNCTION SECURITY FIXES
-- Fix all remaining functions that lack secure search_path settings

-- Fix handle_staff_user_creation function
CREATE OR REPLACE FUNCTION public.handle_staff_user_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  facility_record facilities%ROWTYPE;
  clinic_code_from_metadata text;
BEGIN
  -- Get clinic code from user metadata (passed during sign up)
  clinic_code_from_metadata := NEW.raw_user_meta_data ->> 'clinic_code';
  
  -- If clinic code is provided, find the facility and associate the user
  IF clinic_code_from_metadata IS NOT NULL THEN
    SELECT * INTO facility_record 
    FROM public.facilities 
    WHERE clinic_code = clinic_code_from_metadata 
    LIMIT 1;
    
    -- Create user record with facility association
    IF facility_record.id IS NOT NULL THEN
      INSERT INTO public.users (auth_user_id, name, user_role, facility_id, verified)
      VALUES (
        NEW.id, 
        COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
        COALESCE(
          (NEW.raw_user_meta_data ->> 'user_role')::public.user_role,
          'receptionist'::public.user_role
        ),
        facility_record.id,  -- Associate with facility
        true
      );
    ELSE
      -- If clinic code doesn't match any facility, create user without facility
      INSERT INTO public.users (auth_user_id, name, user_role, verified)
      VALUES (
        NEW.id, 
        COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
        COALESCE(
          (NEW.raw_user_meta_data ->> 'user_role')::public.user_role,
          'receptionist'::public.user_role
        ),
        true
      );
    END IF;
  ELSE
    -- For clinic admins and users without clinic code
    INSERT INTO public.users (auth_user_id, name, user_role, verified)
    VALUES (
      NEW.id, 
      COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
      COALESCE(
        (NEW.raw_user_meta_data ->> 'user_role')::public.user_role,
        'receptionist'::public.user_role
      ),
      true
    );
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN others THEN
    -- If enum casting fails or other errors, use default
    INSERT INTO public.users (auth_user_id, name, user_role, verified)
    VALUES (
      NEW.id, 
      COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
      'receptionist'::public.user_role,
      true
    );
    RETURN NEW;
END;
$function$;

-- Fix create_user_without_auth function
CREATE OR REPLACE FUNCTION public.create_user_without_auth(phone_number_input text, password_input text, full_name_input text, user_role_input text, facility_id_input uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  new_user_id uuid;
  result jsonb;
BEGIN
  -- Check if user already exists
  IF EXISTS (SELECT 1 FROM public.users WHERE phone_number = phone_number_input) THEN
    RETURN jsonb_build_object('success', false, 'error', 'User with this phone number already exists');
  END IF;

  -- Create user record directly
  INSERT INTO public.users (
    id,
    phone_number,
    name,
    user_role,
    facility_id,
    verified,
    password_hash,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    phone_number_input,
    full_name_input,
    user_role_input::text,
    facility_id_input,
    true,
    crypt(password_input, gen_salt('bf')),
    now(),
    now()
  ) RETURNING id INTO new_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'user_id', new_user_id
  );
END;
$function$;

-- Fix generate_clinic_code function
CREATE OR REPLACE FUNCTION public.generate_clinic_code(clinic_name_input text DEFAULT ''::text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  code TEXT;
  exists_check BOOLEAN;
  name_prefix TEXT;
BEGIN
  -- Extract first two letters from clinic name, convert to uppercase
  IF clinic_name_input IS NOT NULL AND length(clinic_name_input) > 0 THEN
    name_prefix := upper(regexp_replace(clinic_name_input, '[^A-Za-z]', '', 'g'));
    
    -- If name has less than 2 letters, pad with 'C' for Clinic
    IF length(name_prefix) < 2 THEN
      name_prefix := rpad(coalesce(name_prefix, 'C'), 2, 'C');
    ELSE
      name_prefix := left(name_prefix, 2);
    END IF;
  ELSE
    -- Default prefix if no clinic name provided
    name_prefix := 'CL';
  END IF;
  
  LOOP
    -- Generate code with clinic name prefix + 2 numbers + 1 letter + 1 number
    code := name_prefix ||
            trunc(random() * 10)::text ||           -- First number
            trunc(random() * 10)::text ||           -- Second number  
            chr(trunc(random() * 26)::int + 65) ||  -- Letter
            trunc(random() * 10)::text;             -- Third number
    
    -- Check if code already exists
    SELECT EXISTS(SELECT 1 FROM public.facilities WHERE clinic_code = code) INTO exists_check;
    
    -- Exit loop if code is unique
    EXIT WHEN NOT exists_check;
  END LOOP;
  
  RETURN code;
END;
$function$;

-- Fix verify_user_credentials function
CREATE OR REPLACE FUNCTION public.verify_user_credentials(phone_number_input text, password_input text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  user_record public.users%ROWTYPE;
  result jsonb;
BEGIN
  -- Get user record
  SELECT * INTO user_record 
  FROM public.users 
  WHERE phone_number = phone_number_input;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;

  -- Verify password
  IF user_record.password_hash = crypt(password_input, user_record.password_hash) THEN
    RETURN jsonb_build_object(
      'success', true,
      'user', jsonb_build_object(
        'id', user_record.id,
        'phone_number', user_record.phone_number,
        'name', user_record.name,
        'user_role', user_record.user_role,
        'facility_id', user_record.facility_id
      )
    );
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;
END;
$function$;

-- Fix update_users_facility_association function
CREATE OR REPLACE FUNCTION public.update_users_facility_association()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  updated_count INTEGER := 0;
  user_record RECORD;
  facility_record RECORD;
BEGIN
  -- Only super admins can run this function
  IF NOT public.is_super_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Super admin access required');
  END IF;

  -- Loop through users with null facility_id who have clinic codes in their metadata
  FOR user_record IN 
    SELECT u.id, u.auth_user_id, au.raw_user_meta_data ->> 'clinic_code' as clinic_code
    FROM public.users u
    JOIN auth.users au ON u.auth_user_id = au.id
    WHERE u.facility_id IS NULL 
    AND au.raw_user_meta_data ->> 'clinic_code' IS NOT NULL
  LOOP
    -- Find the facility for this clinic code
    SELECT * INTO facility_record 
    FROM public.facilities 
    WHERE clinic_code = user_record.clinic_code 
    LIMIT 1;
    
    -- Update user with facility_id if facility found
    IF facility_record.id IS NOT NULL THEN
      UPDATE public.users 
      SET facility_id = facility_record.id, updated_at = now()
      WHERE id = user_record.id;
      
      updated_count := updated_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'updated_count', updated_count,
    'message', 'Users facility association updated successfully'
  );
END;
$function$;

-- Fix update_clinic_verification function
CREATE OR REPLACE FUNCTION public.update_clinic_verification(clinic_id uuid, new_status text, admin_notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
BEGIN
  -- Check if user is super admin
  IF NOT public.is_super_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Super admin access required');
  END IF;

  -- Update facility verification status
  UPDATE public.facilities 
  SET 
    verification_status = new_status,
    verified = CASE WHEN new_status = 'approved' THEN true ELSE false END,
    admin_notes = COALESCE(update_clinic_verification.admin_notes, facilities.admin_notes),
    updated_at = now()
  WHERE id = clinic_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Clinic not found');
  END IF;

  RETURN jsonb_build_object(
    'success', true, 
    'message', 'Clinic verification status updated successfully'
  );
END;
$function$;

-- Fix promote_to_super_admin function
CREATE OR REPLACE FUNCTION public.promote_to_super_admin(user_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  target_user_id uuid;
  result jsonb;
BEGIN
  -- Find the user by phone number
  SELECT auth_user_id INTO target_user_id
  FROM public.users
  WHERE phone_number = user_phone
  LIMIT 1;

  IF target_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found with phone: ' || user_phone);
  END IF;

  -- Update user role to super_admin
  UPDATE public.users
  SET user_role = 'super_admin',
      updated_at = now()
  WHERE auth_user_id = target_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'User promoted to super admin successfully',
    'user_id', target_user_id
  );
END;
$function$;

-- Fix auto_generate_clinic_code function
CREATE OR REPLACE FUNCTION public.auto_generate_clinic_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.clinic_code IS NULL OR NEW.clinic_code = '' THEN
    NEW.clinic_code := public.generate_clinic_code(NEW.name);
  END IF;
  RETURN NEW;
END;
$function$;

-- Fix auto_schedule_challenge_reminder function
CREATE OR REPLACE FUNCTION public.auto_schedule_challenge_reminder()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Schedule reminder when user joins a challenge
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM public.schedule_challenge_reminder(
      NEW.user_id,
      NEW.challenge_id,
      NEW.phone_number,
      'eligibility'
    );
  END IF;
  
  -- Cancel reminders when challenge is completed
  IF TG_OP = 'UPDATE' AND OLD.status != 'completed' AND NEW.status = 'completed' THEN
    PERFORM public.cancel_challenge_reminders(
      NEW.user_id,
      NEW.challenge_id
    );
  END IF;
  
  RETURN NEW;
END;
$function$;