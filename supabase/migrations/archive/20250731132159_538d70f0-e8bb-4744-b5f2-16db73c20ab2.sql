-- Check current RLS policies and fix them properly
-- First, let's see what policies exist and remove conflicting ones

-- Drop all existing INSERT policies to start fresh
DROP POLICY IF EXISTS "Allow clinic registration" ON public.facilities;
DROP POLICY IF EXISTS "Authenticated users can register facilities" ON public.facilities;
DROP POLICY IF EXISTS "Anonymous users can register facilities" ON public.facilities;
DROP POLICY IF EXISTS "Anyone can register a facility" ON public.facilities;

-- Temporarily disable RLS to allow registration, then re-enable with proper policies
ALTER TABLE public.facilities DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;

-- Create a simple, permissive INSERT policy that allows facility registration
CREATE POLICY "Enable facility registration for all users" 
ON public.facilities 
FOR INSERT 
WITH CHECK (true);

-- Keep the existing SELECT policies but ensure they work
-- Anyone can view verified facilities
CREATE POLICY "Public can view verified facilities" 
ON public.facilities 
FOR SELECT 
USING (verified = true);

-- Providers can view their own facility
CREATE POLICY "Providers can view own facility" 
ON public.facilities 
FOR SELECT 
USING (admin_user_id = auth.uid());

-- Admins and super admins can view all facilities
CREATE POLICY "Admins can view all facilities" 
ON public.facilities 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.users 
    WHERE auth_user_id = auth.uid() 
    AND user_role IN ('admin', 'super_admin')
  )
);