-- Migrate existing admin users to hospital_ceo
UPDATE public.users 
SET user_role = 'hospital_ceo'
WHERE user_role = 'admin';

-- Migrate existing clinical_officer users to doctor
UPDATE public.users 
SET user_role = 'doctor'
WHERE user_role = 'clinical_officer';

-- Update get_user_facility_id function to support all new roles
CREATE OR REPLACE FUNCTION public.get_user_facility_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    -- Check if user is facility admin (now hospital_ceo)
    (SELECT f.id FROM facilities f JOIN users u ON f.admin_user_id = u.id WHERE u.auth_user_id = auth.uid()),
    -- Check if user is staff member with facility_id (includes all roles)
    (SELECT u.facility_id FROM users u WHERE u.auth_user_id = auth.uid() AND u.facility_id IS NOT NULL)
  );
$function$;

-- Medical director can view all lab orders
CREATE POLICY "Medical director can view all lab orders"
ON public.lab_orders
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'medical_director'
  )
);

-- Medical director can view all imaging orders
CREATE POLICY "Medical director can view all imaging orders"
ON public.imaging_orders
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'medical_director'
  )
);

-- Nursing head can view all medication orders
CREATE POLICY "Nursing head can view all medication orders"
ON public.medication_orders
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'nursing_head'
  )
);

-- Finance can view all billing
CREATE POLICY "Finance can view all billing"
ON public.billing_items
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'finance'
  )
);

-- RHB can view all patients
CREATE POLICY "RHB can view all patients"
ON public.patients
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'rhb'
  )
);

-- RHB can view all visits
CREATE POLICY "RHB can view all visits"
ON public.visits
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'rhb'
  )
);

-- RHB can view all facilities
CREATE POLICY "RHB can view all facilities"
ON public.facilities
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'rhb'
  )
);