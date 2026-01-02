-- Create a table to track individual votes on feature requests
CREATE TABLE IF NOT EXISTS public.feature_request_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_request_id UUID NOT NULL REFERENCES public.feature_requests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('upvote', 'downvote')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(feature_request_id, user_id)
);

-- Enable RLS
ALTER TABLE public.feature_request_votes ENABLE ROW LEVEL SECURITY;

-- Allow users to view all votes
CREATE POLICY "Users can view all votes"
ON public.feature_request_votes
FOR SELECT
TO authenticated
USING (true);

-- Allow users to manage their own votes
CREATE POLICY "Users can manage their own votes"
ON public.feature_request_votes
FOR ALL
TO authenticated
USING (user_id IN (SELECT id FROM users WHERE auth_user_id = auth.uid()))
WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_user_id = auth.uid()));

-- Create a function to get vote counts
CREATE OR REPLACE FUNCTION get_feature_request_vote_counts(request_id UUID)
RETURNS TABLE(upvotes BIGINT, downvotes BIGINT) 
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT 
    COUNT(*) FILTER (WHERE vote_type = 'upvote') as upvotes,
    COUNT(*) FILTER (WHERE vote_type = 'downvote') as downvotes
  FROM feature_request_votes
  WHERE feature_request_id = request_id;
$$;

-- Add attachment_urls column to feature_requests if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'feature_requests' 
    AND column_name = 'attachment_urls'
  ) THEN
    ALTER TABLE public.feature_requests 
    ADD COLUMN attachment_urls TEXT[];
  END IF;
END $$;

-- Update RLS policy to allow users to view all feature requests (for community tab)
CREATE POLICY "Users can view all feature requests"
ON public.feature_requests
FOR SELECT
TO authenticated
USING (true);

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_feature_request_votes_request_id 
ON public.feature_request_votes(feature_request_id);

CREATE INDEX IF NOT EXISTS idx_feature_request_votes_user_id 
ON public.feature_request_votes(user_id);