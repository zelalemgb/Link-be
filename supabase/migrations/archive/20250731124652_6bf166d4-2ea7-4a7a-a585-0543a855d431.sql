-- Allow public access to read the default super admin for authentication
CREATE POLICY "Allow access to default super admin" 
ON public.users 
FOR SELECT 
USING (
  phone_number = '+251900000000' 
  AND user_role = 'super_admin' 
  AND auth_user_id IS NULL
);