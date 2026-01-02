-- Create staff registration requests table for approval workflow
CREATE TABLE public.staff_registration_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID NOT NULL,
  facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  requested_role TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  reviewed_by UUID REFERENCES public.users(id),
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.staff_registration_requests ENABLE ROW LEVEL SECURITY;

-- Policy: Users can create their own registration requests
CREATE POLICY "Users can create registration requests"
ON public.staff_registration_requests
FOR INSERT
TO authenticated
WITH CHECK (auth_user_id = auth.uid());

-- Policy: Users can view their own registration requests
CREATE POLICY "Users can view their own requests"
ON public.staff_registration_requests
FOR SELECT
TO authenticated
USING (auth_user_id = auth.uid());

-- Policy: Clinic admins can view requests for their facilities
CREATE POLICY "Admins can view facility requests"
ON public.staff_registration_requests
FOR SELECT
TO authenticated
USING (
  facility_id IN (
    SELECT f.id FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  )
  OR is_super_admin()
);

-- Policy: Clinic admins can update (approve/reject) requests for their facilities
CREATE POLICY "Admins can manage facility requests"
ON public.staff_registration_requests
FOR UPDATE
TO authenticated
USING (
  facility_id IN (
    SELECT f.id FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  )
  OR is_super_admin()
)
WITH CHECK (
  facility_id IN (
    SELECT f.id FROM public.facilities f
    JOIN public.users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  )
  OR is_super_admin()
);

-- Add trigger for updated_at
CREATE TRIGGER update_staff_registration_requests_updated_at
BEFORE UPDATE ON public.staff_registration_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add index for faster queries
CREATE INDEX idx_staff_requests_facility_status ON public.staff_registration_requests(facility_id, status);
CREATE INDEX idx_staff_requests_auth_user ON public.staff_registration_requests(auth_user_id);