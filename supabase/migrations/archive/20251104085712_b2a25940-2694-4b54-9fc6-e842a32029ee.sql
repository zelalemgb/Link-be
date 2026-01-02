-- Create feature_requests table for user feedback and suggestions
CREATE TABLE public.feature_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) NOT NULL,
  facility_id uuid REFERENCES public.facilities(id),
  
  -- Context capture
  form_type text NOT NULL,
  page_url text NOT NULL,
  field_name text,
  
  -- Request details
  request_type text NOT NULL CHECK (request_type IN ('rename_field', 'add_field', 'remove_field', 'change_validation', 'feature_suggestion', 'bug_report')),
  priority text DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status text DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'approved', 'implemented', 'rejected')),
  
  -- User input
  current_value text,
  desired_value text,
  description text NOT NULL,
  use_case text,
  
  -- Metadata
  screenshot_url text,
  affected_users_count integer DEFAULT 1,
  upvotes integer DEFAULT 0,
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  reviewed_by uuid REFERENCES public.users(id),
  reviewed_at timestamptz,
  admin_notes text
);

-- Enable RLS
ALTER TABLE public.feature_requests ENABLE ROW LEVEL SECURITY;

-- Users can create feature requests
CREATE POLICY "Users can create feature requests"
  ON public.feature_requests FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Users can view their own requests
CREATE POLICY "Users can view own requests"
  ON public.feature_requests FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE auth_user_id = auth.uid()));

-- Users can update their own requests (for upvoting)
CREATE POLICY "Users can update own requests"
  ON public.feature_requests FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE auth_user_id = auth.uid()));

-- Admins and medical directors can view all requests
CREATE POLICY "Admins can view all requests"
  ON public.feature_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('super_admin', 'medical_director')
    )
  );

-- Admins and medical directors can update all requests
CREATE POLICY "Admins can update all requests"
  ON public.feature_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('super_admin', 'medical_director')
    )
  );

-- Create index for faster queries
CREATE INDEX idx_feature_requests_user_id ON public.feature_requests(user_id);
CREATE INDEX idx_feature_requests_status ON public.feature_requests(status);
CREATE INDEX idx_feature_requests_form_type ON public.feature_requests(form_type);
CREATE INDEX idx_feature_requests_created_at ON public.feature_requests(created_at DESC);

-- Trigger to update updated_at timestamp
CREATE TRIGGER update_feature_requests_updated_at
  BEFORE UPDATE ON public.feature_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();