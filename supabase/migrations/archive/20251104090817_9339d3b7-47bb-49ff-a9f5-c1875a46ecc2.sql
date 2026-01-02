-- Fix RLS policy for feature_requests to allow proper user insertion
DROP POLICY IF EXISTS "Users can create feature requests" ON public.feature_requests;

-- Create corrected policy that checks if user_id matches authenticated user
CREATE POLICY "Users can create feature requests"
  ON public.feature_requests FOR INSERT
  WITH CHECK (
    user_id IN (
      SELECT id FROM public.users WHERE auth_user_id = auth.uid()
    )
  );