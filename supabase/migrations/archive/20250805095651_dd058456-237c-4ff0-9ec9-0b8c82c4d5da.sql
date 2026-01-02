-- Function to update existing users with null facility_id based on clinic codes
CREATE OR REPLACE FUNCTION public.update_users_facility_association()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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