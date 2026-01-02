-- Check and fix RLS policies for facilities table
-- The issue is likely that the INSERT policy is not working correctly

-- First, let's drop and recreate the INSERT policy for facility registration
DROP POLICY IF EXISTS "Anyone can register a facility" ON public.facilities;

-- Create a more permissive INSERT policy for clinic registration
CREATE POLICY "Allow clinic registration" 
ON public.facilities 
FOR INSERT 
WITH CHECK (true);

-- Also ensure we have a policy that allows authenticated users to insert
CREATE POLICY "Authenticated users can register facilities" 
ON public.facilities 
FOR INSERT 
TO authenticated
WITH CHECK (true);

-- Let's also create a policy for anonymous users to register (for initial clinic setup)
CREATE POLICY "Anonymous users can register facilities" 
ON public.facilities 
FOR INSERT 
TO anon
WITH CHECK (true);