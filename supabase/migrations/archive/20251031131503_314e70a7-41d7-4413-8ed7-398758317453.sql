-- Drop the existing restrictive INSERT policy
DROP POLICY IF EXISTS "Anyone can create patient account" ON public.patient_accounts;

-- Create a truly permissive INSERT policy for patient registration
CREATE POLICY "Allow public patient registration"
ON public.patient_accounts
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

-- Also ensure the SELECT policy works for unauthenticated lookups during login
DROP POLICY IF EXISTS "Patients can view their own account" ON public.patient_accounts;

CREATE POLICY "Anyone can view accounts during auth"
ON public.patient_accounts
FOR SELECT
TO anon, authenticated
USING (true);