-- Allow clinic admins to complete self-registration without facility metadata
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
  user_role_from_metadata := COALESCE(
    NEW.raw_user_meta_data ->> 'user_role',
    NEW.raw_user_meta_data ->> 'role',
    'receptionist'
  );

  -- Clinic admins and super admins can onboard before a facility exists
  IF user_role_from_metadata IN ('super_admin', 'admin') THEN
    INSERT INTO public.users (auth_user_id, name, user_role, verified)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name', ''),
      user_role_from_metadata::public.user_role,
      true
    );
    RETURN NEW;
  END IF;

  -- Existing clinics still require either a facility_id or clinic_code
  facility_id_from_metadata := NEW.raw_user_meta_data ->> 'facility_id';

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

  RAISE EXCEPTION 'User registration requires facility association. Please register through a clinic or provide a valid clinic code.';
END;
$function$;

COMMENT ON FUNCTION public.handle_staff_user_creation() IS
'Trigger function that creates public.users records when auth.users are created.
Admins and super admins can register without facility metadata; all other roles require a facility_id or clinic_code.';
