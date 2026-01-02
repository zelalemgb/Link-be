-- Create enum types for our patient management system
CREATE TYPE user_role AS ENUM ('admin', 'receptionist', 'nurse');
CREATE TYPE premium_status AS ENUM ('pending', 'verified');

-- Add columns to existing users table for our patient management system
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS user_role user_role DEFAULT 'receptionist';

-- Create patients table
CREATE TABLE IF NOT EXISTS public.patients (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('Male', 'Female', 'Other')),
  age INTEGER NOT NULL CHECK (age > 0 AND age < 150),
  phone TEXT,
  created_by UUID REFERENCES public.users(id) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create visits table
CREATE TABLE IF NOT EXISTS public.visits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID REFERENCES public.patients(id) NOT NULL,
  visit_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reason TEXT NOT NULL,
  provider TEXT NOT NULL,
  temperature FLOAT,
  weight FLOAT,
  blood_pressure TEXT,
  fee_paid FLOAT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES public.users(id) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create premium_requests table
CREATE TABLE IF NOT EXISTS public.premium_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) NOT NULL,
  proof_image TEXT NOT NULL,
  status premium_status NOT NULL DEFAULT 'pending',
  submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  verified_at TIMESTAMP WITH TIME ZONE,
  verified_by UUID REFERENCES public.users(id)
);

-- Enable Row Level Security
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.premium_requests ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for patients
CREATE POLICY "Users can view all patients" ON public.patients
  FOR SELECT USING (true);

CREATE POLICY "Users can create patients" ON public.patients
  FOR INSERT WITH CHECK (created_by IN (
    SELECT id FROM public.users WHERE auth_user_id = auth.uid()
  ));

CREATE POLICY "Users can update patients they created" ON public.patients
  FOR UPDATE USING (created_by IN (
    SELECT id FROM public.users WHERE auth_user_id = auth.uid()
  ));

-- Create RLS policies for visits
CREATE POLICY "Users can view all visits" ON public.visits
  FOR SELECT USING (true);

CREATE POLICY "Users can create visits" ON public.visits
  FOR INSERT WITH CHECK (created_by IN (
    SELECT id FROM public.users WHERE auth_user_id = auth.uid()
  ));

CREATE POLICY "Users can update visits they created" ON public.visits
  FOR UPDATE USING (created_by IN (
    SELECT id FROM public.users WHERE auth_user_id = auth.uid()
  ));

-- Create RLS policies for premium_requests
CREATE POLICY "Users can view their own premium requests" ON public.premium_requests
  FOR SELECT USING (user_id IN (
    SELECT id FROM public.users WHERE auth_user_id = auth.uid()
  ));

CREATE POLICY "Users can create their own premium requests" ON public.premium_requests
  FOR INSERT WITH CHECK (user_id IN (
    SELECT id FROM public.users WHERE auth_user_id = auth.uid()
  ));

CREATE POLICY "Admins can view all premium requests" ON public.premium_requests
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.users 
    WHERE auth_user_id = auth.uid() AND user_role = 'admin'
  ));

CREATE POLICY "Admins can update premium requests" ON public.premium_requests
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.users 
    WHERE auth_user_id = auth.uid() AND user_role = 'admin'
  ));

-- Create triggers for updated_at if they don't exist
CREATE TRIGGER update_patients_updated_at
  BEFORE UPDATE ON public.patients
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_visits_updated_at
  BEFORE UPDATE ON public.visits
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_patients_created_by ON public.patients(created_by);
CREATE INDEX IF NOT EXISTS idx_patients_full_name ON public.patients(full_name);
CREATE INDEX IF NOT EXISTS idx_visits_patient_id ON public.visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_visit_date ON public.visits(visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_created_by ON public.visits(created_by);