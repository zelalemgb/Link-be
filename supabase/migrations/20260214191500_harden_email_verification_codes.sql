-- Harden staff email verification records:
-- 1) remove permissive public RLS policies
-- 2) block direct anon/authenticated reads and writes
-- Backend service-role routes now exclusively manage this table.

DROP POLICY IF EXISTS "Anyone can insert verification codes" ON public.email_verification_codes;
DROP POLICY IF EXISTS "Anyone can verify codes they know" ON public.email_verification_codes;
DROP POLICY IF EXISTS "Anyone can mark codes as verified" ON public.email_verification_codes;
DROP POLICY IF EXISTS "Users can view their own verification codes" ON public.email_verification_codes;
DROP POLICY IF EXISTS "Users can update their own verification codes" ON public.email_verification_codes;

REVOKE ALL ON TABLE public.email_verification_codes FROM anon;
REVOKE ALL ON TABLE public.email_verification_codes FROM authenticated;
