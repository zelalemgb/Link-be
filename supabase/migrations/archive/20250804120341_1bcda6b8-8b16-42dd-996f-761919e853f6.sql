-- Add facility_id to patients table to link patients to specific clinics
ALTER TABLE public.patients 
ADD COLUMN facility_id uuid REFERENCES public.facilities(id);

-- Create index for better performance
CREATE INDEX idx_patients_facility_id ON public.patients(facility_id);

-- Drop the overly permissive policy that allows all users to view all patients
DROP POLICY IF EXISTS "Users can view all patients" ON public.patients;

-- Create new restrictive policies for patient access
CREATE POLICY "Super admins can view all patients" 
ON public.patients 
FOR SELECT 
USING (is_super_admin());

CREATE POLICY "Clinic staff can view patients from their facility" 
ON public.patients 
FOR SELECT 
USING (
  facility_id IN (
    SELECT f.id 
    FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  ) OR 
  facility_id IN (
    SELECT u.facility_id 
    FROM public.users u 
    WHERE u.auth_user_id = auth.uid() AND u.facility_id IS NOT NULL
  )
);

CREATE POLICY "Clinic staff can create patients for their facility" 
ON public.patients 
FOR INSERT 
WITH CHECK (
  facility_id IN (
    SELECT f.id 
    FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  ) OR 
  facility_id IN (
    SELECT u.facility_id 
    FROM public.users u 
    WHERE u.auth_user_id = auth.uid() AND u.facility_id IS NOT NULL
  )
);

CREATE POLICY "Clinic staff can update patients from their facility" 
ON public.patients 
FOR UPDATE 
USING (
  facility_id IN (
    SELECT f.id 
    FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  ) OR 
  facility_id IN (
    SELECT u.facility_id 
    FROM public.users u 
    WHERE u.auth_user_id = auth.uid() AND u.facility_id IS NOT NULL
  )
);

-- Update visits table to also include facility_id for better data organization
ALTER TABLE public.visits 
ADD COLUMN facility_id uuid REFERENCES public.facilities(id);

-- Create index for visits facility_id
CREATE INDEX idx_visits_facility_id ON public.visits(facility_id);

-- Update RLS policies for visits to be facility-specific
DROP POLICY IF EXISTS "Users can view all visits" ON public.visits;

CREATE POLICY "Super admins can view all visits" 
ON public.visits 
FOR SELECT 
USING (is_super_admin());

CREATE POLICY "Clinic staff can view visits from their facility" 
ON public.visits 
FOR SELECT 
USING (
  facility_id IN (
    SELECT f.id 
    FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  ) OR 
  facility_id IN (
    SELECT u.facility_id 
    FROM public.users u 
    WHERE u.auth_user_id = auth.uid() AND u.facility_id IS NOT NULL
  )
);

CREATE POLICY "Clinic staff can create visits for their facility" 
ON public.visits 
FOR INSERT 
WITH CHECK (
  facility_id IN (
    SELECT f.id 
    FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  ) OR 
  facility_id IN (
    SELECT u.facility_id 
    FROM public.users u 
    WHERE u.auth_user_id = auth.uid() AND u.facility_id IS NOT NULL
  )
);

CREATE POLICY "Clinic staff can update visits from their facility" 
ON public.visits 
FOR UPDATE 
USING (
  facility_id IN (
    SELECT f.id 
    FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  ) OR 
  facility_id IN (
    SELECT u.facility_id 
    FROM public.users u 
    WHERE u.auth_user_id = auth.uid() AND u.facility_id IS NOT NULL
  )
);

-- Add facility_id to users table to link staff to facilities
ALTER TABLE public.users 
ADD COLUMN facility_id uuid REFERENCES public.facilities(id);

-- Create index for users facility_id
CREATE INDEX idx_users_facility_id ON public.users(facility_id);