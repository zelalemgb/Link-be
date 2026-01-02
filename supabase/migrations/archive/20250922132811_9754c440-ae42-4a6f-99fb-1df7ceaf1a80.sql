-- Reset password for existing super admin user
UPDATE auth.users 
SET encrypted_password = crypt('superadmin123', gen_salt('bf'))
WHERE email = 'zelalem@opiantech.com';