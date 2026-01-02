-- Create beta_registrations table for clinic beta applications
CREATE TABLE public.beta_registrations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_name TEXT NOT NULL,
  clinic_address TEXT NOT NULL,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'Ethiopia',
  coordinates JSONB,
  clinic_type TEXT NOT NULL,
  patient_volume_monthly TEXT NOT NULL,
  specializations TEXT[],
  contact_person_name TEXT NOT NULL,
  contact_person_role TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  current_record_system TEXT,
  beta_motivation TEXT,
  status TEXT DEFAULT 'pending',
  reviewed_at TIMESTAMP WITH TIME ZONE,
  reviewed_by UUID,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on beta_registrations
ALTER TABLE public.beta_registrations ENABLE ROW LEVEL SECURITY;

-- Create policies for beta_registrations
CREATE POLICY "Anyone can submit beta registration" 
ON public.beta_registrations 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Admins can view all beta registrations" 
ON public.beta_registrations 
FOR SELECT 
USING (is_super_admin());

CREATE POLICY "Admins can update beta registrations" 
ON public.beta_registrations 
FOR UPDATE 
USING (is_super_admin());

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_beta_registrations_updated_at
BEFORE UPDATE ON public.beta_registrations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add index for efficient querying
CREATE INDEX idx_beta_registrations_status ON public.beta_registrations(status);
CREATE INDEX idx_beta_registrations_created_at ON public.beta_registrations(created_at);