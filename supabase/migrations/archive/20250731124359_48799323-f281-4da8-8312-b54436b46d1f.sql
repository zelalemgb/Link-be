-- Create a default super admin account
INSERT INTO public.users (
  id,
  phone_number,
  name,
  full_name,
  user_role,
  verified,
  auth_user_id,
  created_at,
  updated_at
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  '+251900000000',
  'Super Admin',
  'System Administrator',
  'super_admin',
  true,
  null, -- No auth_user_id needed for default super admin
  now(),
  now()
) ON CONFLICT (id) DO UPDATE SET
  phone_number = EXCLUDED.phone_number,
  name = EXCLUDED.name,
  full_name = EXCLUDED.full_name,
  user_role = EXCLUDED.user_role,
  verified = EXCLUDED.verified,
  updated_at = now();