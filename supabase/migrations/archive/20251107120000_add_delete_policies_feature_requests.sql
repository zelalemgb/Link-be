-- Allow users and admins to delete feature requests
DROP POLICY IF EXISTS "Users can delete own requests" ON public.feature_requests;
DROP POLICY IF EXISTS "Admins can delete all requests" ON public.feature_requests;

CREATE POLICY "Users can delete own requests"
  ON public.feature_requests FOR DELETE
  USING (
    user_id IN (
      SELECT id FROM public.users WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "Admins can delete all requests"
  ON public.feature_requests FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('super_admin', 'medical_director')
    )
  );
