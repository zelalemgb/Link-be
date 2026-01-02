-- Add confirmation tracking to feature_requests table
ALTER TABLE public.feature_requests
ADD COLUMN confirmed_at TIMESTAMPTZ,
ADD COLUMN confirmed_by_user_id UUID REFERENCES public.users(id);

-- Add index for better query performance
CREATE INDEX idx_feature_requests_confirmed_at ON public.feature_requests(confirmed_at);

-- Add comment for documentation
COMMENT ON COLUMN public.feature_requests.confirmed_at IS 'Timestamp when the user confirmed the implemented feature';
COMMENT ON COLUMN public.feature_requests.confirmed_by_user_id IS 'ID of the user who confirmed the implementation';