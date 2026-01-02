-- Create super admin function to check role
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'super_admin'
  );
$$;

-- Update facilities RLS policies to allow super admin access
DROP POLICY IF EXISTS "Super admins can manage all facilities" ON public.facilities;
CREATE POLICY "Super admins can manage all facilities" 
ON public.facilities 
FOR ALL 
TO authenticated
USING (public.is_super_admin());

-- Update users RLS policies to allow super admin access  
DROP POLICY IF EXISTS "Super admins can manage all users" ON public.users;
CREATE POLICY "Super admins can manage all users" 
ON public.users 
FOR ALL 
TO authenticated
USING (public.is_super_admin());

-- Update patients RLS policies to allow super admin access
DROP POLICY IF EXISTS "Super admins can manage all patients" ON public.patients;
CREATE POLICY "Super admins can manage all patients" 
ON public.patients 
FOR ALL 
TO authenticated  
USING (public.is_super_admin());

-- Update visits RLS policies to allow super admin access
DROP POLICY IF EXISTS "Super admins can manage all visits" ON public.visits;
CREATE POLICY "Super admins can manage all visits" 
ON public.visits 
FOR ALL 
TO authenticated
USING (public.is_super_admin());

-- Add function to approve/reject clinic registrations
CREATE OR REPLACE FUNCTION public.update_clinic_verification(
  clinic_id uuid,
  new_status text,
  admin_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
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
$$;