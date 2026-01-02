-- Create a function to create default super admin
CREATE OR REPLACE FUNCTION public.create_default_super_admin()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- Insert default super admin user into public.users table
  -- This will be used as a reference, actual auth will be handled through normal sign up
  INSERT INTO public.users (
    id,
    auth_user_id,
    full_name,
    phone_number,
    user_role,
    created_at,
    updated_at
  ) VALUES (
    'a0000000-0000-0000-0000-000000000001'::uuid,
    null, -- Will be updated when super admin signs up
    'System Administrator',
    '+251900000000',
    'super_admin',
    now(),
    now()
  ) ON CONFLICT (id) DO NOTHING;
END;
$$;

-- Execute the function to create the default super admin
SELECT public.create_default_super_admin();

-- Drop the function as it's no longer needed
DROP FUNCTION public.create_default_super_admin();