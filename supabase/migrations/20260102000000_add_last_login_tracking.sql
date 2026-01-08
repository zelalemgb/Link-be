-- Add last_login_at column to track user logins for first-time onboarding detection
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_users_last_login_at 
ON public.users(last_login_at);

-- Add comment for documentation
COMMENT ON COLUMN public.users.last_login_at IS 'Timestamp of the user''s most recent login. NULL indicates user has never logged in.';
