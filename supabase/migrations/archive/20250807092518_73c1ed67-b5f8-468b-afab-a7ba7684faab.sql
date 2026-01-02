-- Fix RLS policy for beta_registrations to allow anonymous submissions
-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Anyone can submit beta registration" ON public.beta_registrations;

-- Create a new policy that explicitly allows anonymous users to insert
CREATE POLICY "Allow public beta registration submissions" 
ON public.beta_registrations 
FOR INSERT 
WITH CHECK (true);

-- Ensure RLS is enabled
ALTER TABLE public.beta_registrations ENABLE ROW LEVEL SECURITY;