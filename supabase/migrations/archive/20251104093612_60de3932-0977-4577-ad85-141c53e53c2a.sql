-- Add RLS policy for clinic admins to view feature requests from their facility
CREATE POLICY "Clinic admins can view their facility feature requests"
ON public.feature_requests
FOR SELECT
TO authenticated
USING (
  facility_id IN (
    SELECT facility_id 
    FROM public.users 
    WHERE auth_user_id = auth.uid() 
    AND user_role = 'admin'
  )
);