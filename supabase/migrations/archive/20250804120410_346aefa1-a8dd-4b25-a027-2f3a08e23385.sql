-- First, add facility_id to users table 
ALTER TABLE public.users 
ADD COLUMN facility_id uuid REFERENCES public.facilities(id);

-- Create index for users facility_id
CREATE INDEX idx_users_facility_id ON public.users(facility_id);

-- Add facility_id to patients table to link patients to specific clinics
ALTER TABLE public.patients 
ADD COLUMN facility_id uuid REFERENCES public.facilities(id);

-- Create index for better performance
CREATE INDEX idx_patients_facility_id ON public.patients(facility_id);

-- Add facility_id to visits table 
ALTER TABLE public.visits 
ADD COLUMN facility_id uuid REFERENCES public.facilities(id);

-- Create index for visits facility_id
CREATE INDEX idx_visits_facility_id ON public.visits(facility_id);

-- Drop the overly permissive policies
DROP POLICY IF EXISTS "Users can view all patients" ON public.patients;
DROP POLICY IF EXISTS "Users can view all visits" ON public.visits;

-- Create security definer function to get user's facility
CREATE OR REPLACE FUNCTION public.get_user_facility_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- Check if user is facility admin
    (SELECT f.id FROM facilities f JOIN users u ON f.admin_user_id = u.id WHERE u.auth_user_id = auth.uid()),
    -- Check if user is staff member with facility_id
    (SELECT u.facility_id FROM users u WHERE u.auth_user_id = auth.uid() AND u.facility_id IS NOT NULL)
  );
$$;

-- Create new restrictive policies for patient access
CREATE POLICY "Super admins can view all patients" 
ON public.patients 
FOR SELECT 
USING (is_super_admin());

CREATE POLICY "Clinic staff can view patients from their facility" 
ON public.patients 
FOR SELECT 
USING (facility_id = get_user_facility_id());

CREATE POLICY "Clinic staff can create patients for their facility" 
ON public.patients 
FOR INSERT 
WITH CHECK (facility_id = get_user_facility_id());

CREATE POLICY "Clinic staff can update patients from their facility" 
ON public.patients 
FOR UPDATE 
USING (facility_id = get_user_facility_id());

-- Create new restrictive policies for visits
CREATE POLICY "Super admins can view all visits" 
ON public.visits 
FOR SELECT 
USING (is_super_admin());

CREATE POLICY "Clinic staff can view visits from their facility" 
ON public.visits 
FOR SELECT 
USING (facility_id = get_user_facility_id());

CREATE POLICY "Clinic staff can create visits for their facility" 
ON public.visits 
FOR INSERT 
WITH CHECK (facility_id = get_user_facility_id());

CREATE POLICY "Clinic staff can update visits from their facility" 
ON public.visits 
FOR UPDATE 
USING (facility_id = get_user_facility_id());