-- Track clinic registrations pending super admin approval
CREATE TABLE public.clinic_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_name TEXT NOT NULL,
  country TEXT,
  location TEXT,
  address TEXT,
  phone_number TEXT,
  email TEXT,
  admin_name TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  admin_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  reviewer_user_id UUID REFERENCES public.users(id),
  reviewed_at TIMESTAMPTZ,
  admin_invite_sent_at TIMESTAMPTZ,
  admin_auth_user_id UUID,
  admin_user_id UUID REFERENCES public.users(id),
  facility_id UUID REFERENCES public.facilities(id),
  tenant_id UUID REFERENCES public.tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clinic_registrations_status ON public.clinic_registrations(status);
CREATE INDEX idx_clinic_registrations_created_at ON public.clinic_registrations(created_at DESC);

ALTER TABLE public.clinic_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit clinic registration"
ON public.clinic_registrations
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Authenticated users can submit clinic registration"
ON public.clinic_registrations
FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Super admins can view clinic registrations"
ON public.clinic_registrations
FOR SELECT
TO authenticated
USING (public.is_super_admin());

CREATE POLICY "Super admins can manage clinic registrations"
ON public.clinic_registrations
FOR UPDATE
TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

CREATE POLICY "Super admins can delete clinic registrations"
ON public.clinic_registrations
FOR DELETE
TO authenticated
USING (public.is_super_admin());

CREATE TRIGGER update_clinic_registrations_updated_at
BEFORE UPDATE ON public.clinic_registrations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
