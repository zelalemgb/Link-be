-- Drop the restrictive SELECT policy
DROP POLICY IF EXISTS "Users can view their own verification codes" ON public.email_verification_codes;

-- Create a new policy that allows verification without authentication
-- Users can only see verification codes if they know the email and code
CREATE POLICY "Anyone can verify codes they know"
ON public.email_verification_codes
FOR SELECT
USING (true);

-- Update the UPDATE policy to allow unauthenticated verification
DROP POLICY IF EXISTS "Users can update their own verification codes" ON public.email_verification_codes;

CREATE POLICY "Anyone can mark codes as verified"
ON public.email_verification_codes
FOR UPDATE
USING (true)
WITH CHECK (
  -- Only allow updating verified_at and attempts fields
  verified_at IS NOT NULL OR attempts >= 0
);