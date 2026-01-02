-- Fix functions that returned multiple rows for multi-facility users
-- 1) Ensure get_user_facility_id returns a single UUID
CREATE OR REPLACE FUNCTION public.get_user_facility_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    -- If user is a facility admin, pick one admin facility deterministically
    (SELECT f.id 
     FROM public.facilities f 
     JOIN public.users u ON f.admin_user_id = u.id 
     WHERE u.auth_user_id = auth.uid() 
     LIMIT 1),
    -- Otherwise, pick one of the user's facilities (if multiple exist)
    (SELECT u.facility_id 
     FROM public.users u 
     WHERE u.auth_user_id = auth.uid() 
       AND u.facility_id IS NOT NULL 
     LIMIT 1)
  );
$function$;

-- 2) Ensure get_current_user_role returns a single value
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS app_role
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT role 
  FROM public.users 
  WHERE auth_user_id = auth.uid()
  LIMIT 1;
$function$;