-- Fix the function search_path issue by setting it explicitly
CREATE OR REPLACE FUNCTION get_feature_request_vote_counts(request_id UUID)
RETURNS TABLE(upvotes BIGINT, downvotes BIGINT) 
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    COUNT(*) FILTER (WHERE vote_type = 'upvote') as upvotes,
    COUNT(*) FILTER (WHERE vote_type = 'downvote') as downvotes
  FROM feature_request_votes
  WHERE feature_request_id = request_id;
$$;