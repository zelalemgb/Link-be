-- Update handle_staff_user_creation to support facility_id from metadata
CREATE OR REPLACE FUNCTION public.handle_staff_user_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  facility_record facilities%ROWTYPE;
  clinic_code_from_metadata text;
  facility_id_from_metadata text;
BEGIN
  -- Get facility_id from user metadata (for invitation-based signup)
  facility_id_from_metadata := NEW.raw_user_meta_data ->> 'facility_id';
  
  -- If facility_id is provided directly, use it
  IF facility_id_from_metadata IS NOT NULL THEN
    INSERT INTO public.users (auth_user_id, name, user_role, facility_id, verified)
    VALUES (
      NEW.id, 
      COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
      COALESCE(
        (NEW.raw_user_meta_data ->> 'user_role')::public.user_role,
        'receptionist'::public.user_role
      ),
      facility_id_from_metadata::uuid,
      true
    );
    RETURN NEW;
  END IF;
  
  -- Otherwise, try clinic code lookup
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
        COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
        COALESCE(
          (NEW.raw_user_meta_data ->> 'user_role')::public.user_role,
          'receptionist'::public.user_role
        ),
        facility_record.id,
        true
      );
    ELSE
      -- Clinic code doesn't match, create without facility
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
    -- No facility info provided, create user without facility
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
    -- If errors occur, create basic user record
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

-- Fix existing users with null facility_id who have accepted invitations
UPDATE public.users u
SET facility_id = si.facility_id,
    user_role = si.role::user_role,
    updated_at = now()
FROM public.staff_invitations si
JOIN auth.users au ON au.email = si.email
WHERE u.auth_user_id = au.id
  AND u.facility_id IS NULL
  AND si.accepted = true
  AND si.facility_id IS NOT NULL;