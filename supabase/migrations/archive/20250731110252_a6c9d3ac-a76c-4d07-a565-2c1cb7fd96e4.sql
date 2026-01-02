-- Create default super admin user
-- First, create auth user
INSERT INTO auth.users (
  id,
  instance_id,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_super_admin,
  role,
  aud,
  confirmation_token,
  email_change_token_current,
  email_change_confirm_status,
  banned_until,
  last_sign_in_at,
  confirmation_sent_at
) VALUES (
  'a0000000-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'superadmin@system.admin',
  crypt('SuperAdmin2024!', gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  '{"full_name": "System Administrator", "phone_number": "+251900000000", "user_role": "super_admin"}'::jsonb,
  false,
  'authenticated',
  'authenticated',
  '',
  '',
  0,
  null,
  null,
  null
) ON CONFLICT (id) DO NOTHING;

-- Then create corresponding user in public.users table
INSERT INTO public.users (
  id,
  auth_user_id,
  full_name,
  phone_number,
  user_role,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  'a0000000-0000-0000-0000-000000000001'::uuid,
  'System Administrator',
  '+251900000000',
  'super_admin',
  now(),
  now()
) ON CONFLICT (auth_user_id) DO NOTHING;