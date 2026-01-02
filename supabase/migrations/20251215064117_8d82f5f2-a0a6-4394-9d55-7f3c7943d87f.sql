-- Create clinic_registrations table for tracking clinic registration requests
CREATE TABLE public.clinic_registrations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_name TEXT NOT NULL,
  location TEXT,
  address TEXT,
  phone_number TEXT,
  email TEXT,
  admin_name TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  admin_phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  reviewer_user_id UUID REFERENCES public.users(id),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  admin_invite_sent_at TIMESTAMP WITH TIME ZONE,
  admin_auth_user_id UUID,
  admin_user_id UUID REFERENCES public.users(id),
  facility_id UUID REFERENCES public.facilities(id),
  tenant_id UUID REFERENCES public.tenants(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.clinic_registrations ENABLE ROW LEVEL SECURITY;

-- Super admins can view all registrations
CREATE POLICY "Super admins can view clinic registrations"
  ON public.clinic_registrations
  FOR SELECT
  USING (is_super_admin());

-- Super admins can update registrations (approve/reject)
CREATE POLICY "Super admins can update clinic registrations"
  ON public.clinic_registrations
  FOR UPDATE
  USING (is_super_admin());

-- Anyone can submit a clinic registration
CREATE POLICY "Anyone can submit clinic registrations"
  ON public.clinic_registrations
  FOR INSERT
  WITH CHECK (true);

-- Add updated_at trigger
CREATE TRIGGER update_clinic_registrations_updated_at
  BEFORE UPDATE ON public.clinic_registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();