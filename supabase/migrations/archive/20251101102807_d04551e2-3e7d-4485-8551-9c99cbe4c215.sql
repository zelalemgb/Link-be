-- Create stock request notifications table
CREATE TABLE IF NOT EXISTS public.stock_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_name TEXT NOT NULL,
  generic_name TEXT,
  requested_quantity INTEGER,
  current_stock INTEGER,
  urgency TEXT NOT NULL DEFAULT 'normal', -- 'urgent', 'normal', 'low'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'acknowledged', 'fulfilled', 'cancelled'
  requested_by UUID NOT NULL REFERENCES public.users(id),
  facility_id UUID REFERENCES public.facilities(id),
  message TEXT,
  acknowledged_by UUID REFERENCES public.users(id),
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  fulfilled_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.stock_requests ENABLE ROW LEVEL SECURITY;

-- Policy: Pharmacists can create stock requests
CREATE POLICY "Pharmacists can create stock requests"
  ON public.stock_requests
  FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.auth_user_id = auth.uid()
      AND users.user_role = ANY(ARRAY['pharmacist'::user_role, 'nurse'::user_role, 'doctor'::user_role])
    )
  );

-- Policy: Facility staff can view stock requests
CREATE POLICY "Facility staff can view stock requests"
  ON public.stock_requests
  FOR SELECT
  USING (
    facility_id = get_user_facility_id() OR is_super_admin()
  );

-- Policy: Logistic officers can update stock requests
CREATE POLICY "Logistic officers can update stock requests"
  ON public.stock_requests
  FOR UPDATE
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.auth_user_id = auth.uid()
      AND users.user_role = ANY(ARRAY['logistic_officer'::user_role, 'pharmacist'::user_role, 'super_admin'::user_role])
    )
  );

-- Create updated_at trigger
CREATE TRIGGER update_stock_requests_updated_at
  BEFORE UPDATE ON public.stock_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create index for better performance
CREATE INDEX idx_stock_requests_status ON public.stock_requests(status);
CREATE INDEX idx_stock_requests_facility ON public.stock_requests(facility_id);
CREATE INDEX idx_stock_requests_created ON public.stock_requests(created_at DESC);