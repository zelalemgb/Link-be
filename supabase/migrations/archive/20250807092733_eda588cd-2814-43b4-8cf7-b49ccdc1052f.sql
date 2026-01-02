-- Check for any restrictive policies and fix them
-- Drop all existing policies to start fresh
DROP POLICY IF EXISTS "Admins can update beta registrations" ON public.beta_registrations;
DROP POLICY IF EXISTS "Admins can view all beta registrations" ON public.beta_registrations;
DROP POLICY IF EXISTS "Allow public beta registration submissions" ON public.beta_registrations;

-- Create simple permissive policies
CREATE POLICY "Enable insert for everyone" ON public.beta_registrations FOR INSERT WITH CHECK (true);
CREATE POLICY "Enable read for admins" ON public.beta_registrations FOR SELECT USING (is_super_admin());
CREATE POLICY "Enable update for admins" ON public.beta_registrations FOR UPDATE USING (is_super_admin());

-- Ensure RLS is enabled
ALTER TABLE public.beta_registrations ENABLE ROW LEVEL SECURITY;