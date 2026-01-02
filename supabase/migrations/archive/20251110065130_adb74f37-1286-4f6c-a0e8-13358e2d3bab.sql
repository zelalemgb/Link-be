-- Create table for email verification codes
CREATE TABLE IF NOT EXISTS public.email_verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  verified_at TIMESTAMP WITH TIME ZONE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  tenant_id UUID
);

-- Create index for faster lookups
CREATE INDEX idx_verification_codes_email ON public.email_verification_codes(email);
CREATE INDEX idx_verification_codes_expires_at ON public.email_verification_codes(expires_at);

-- Enable RLS
ALTER TABLE public.email_verification_codes ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own verification codes
CREATE POLICY "Users can view their own verification codes"
ON public.email_verification_codes
FOR SELECT
USING (email = current_setting('request.jwt.claims', true)::json->>'email');

-- Policy: Anyone can insert verification codes (during signup)
CREATE POLICY "Anyone can insert verification codes"
ON public.email_verification_codes
FOR INSERT
WITH CHECK (true);

-- Policy: Users can update their own verification codes (to mark as verified)
CREATE POLICY "Users can update their own verification codes"
ON public.email_verification_codes
FOR UPDATE
USING (email = current_setting('request.jwt.claims', true)::json->>'email');

-- Add email_verified column to users table if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'users' 
    AND column_name = 'email_verified'
  ) THEN
    ALTER TABLE public.users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- Function to clean up expired verification codes
CREATE OR REPLACE FUNCTION public.cleanup_expired_verification_codes()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.email_verification_codes
  WHERE expires_at < now() - interval '24 hours';
END;
$$;

COMMENT ON TABLE public.email_verification_codes IS 'Stores email verification codes for staff registration';
COMMENT ON FUNCTION public.cleanup_expired_verification_codes IS 'Removes verification codes older than 24 hours past expiry';