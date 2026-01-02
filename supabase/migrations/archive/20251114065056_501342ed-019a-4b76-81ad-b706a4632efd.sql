-- Update handle_staff_user_creation trigger to properly handle super_admin with tenant
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
  tenant_id_from_metadata text;
  user_role_from_metadata text;
BEGIN
  -- Get user role from metadata
  user_role_from_metadata := COALESCE(
    NEW.raw_user_meta_data ->> 'user_role',
    NEW.raw_user_meta_data ->> 'role',
    'receptionist'
  );
  
  -- Get tenant_id from metadata
  tenant_id_from_metadata := NEW.raw_user_meta_data ->> 'tenant_id';
  
  -- Super admins need tenant and facility
  IF user_role_from_metadata = 'super_admin' THEN
    -- Get facility_id from metadata
    facility_id_from_metadata := NEW.raw_user_meta_data ->> 'facility_id';
    
    IF tenant_id_from_metadata IS NULL OR facility_id_from_metadata IS NULL THEN
      RAISE EXCEPTION 'Super admin requires both tenant_id and facility_id in metadata';
    END IF;
    
    INSERT INTO public.users (auth_user_id, name, user_role, tenant_id, facility_id, verified)
    VALUES (
      NEW.id, 
      COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name', ''),
      'super_admin'::public.user_role,
      tenant_id_from_metadata::uuid,
      facility_id_from_metadata::uuid,
      true
    );
    RETURN NEW;
  END IF;
  
  -- Get facility_id from user metadata (for invitation-based signup)
  facility_id_from_metadata := NEW.raw_user_meta_data ->> 'facility_id';
  
  -- If facility_id is provided directly, use it
  IF facility_id_from_metadata IS NOT NULL THEN
    INSERT INTO public.users (auth_user_id, name, user_role, facility_id, tenant_id, verified)
    VALUES (
      NEW.id, 
      COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name', ''),
      user_role_from_metadata::public.user_role,
      facility_id_from_metadata::uuid,
      tenant_id_from_metadata::uuid,
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
      INSERT INTO public.users (auth_user_id, name, user_role, facility_id, tenant_id, verified)
      VALUES (
        NEW.id, 
        COALESCE(NEW.raw_user_meta_data ->> 'name', NEW.raw_user_meta_data ->> 'full_name', ''),
        user_role_from_metadata::public.user_role,
        facility_record.id,
        facility_record.tenant_id,
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