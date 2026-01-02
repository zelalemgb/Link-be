-- Add importance_tag column to feature_requests table
ALTER TABLE feature_requests 
ADD COLUMN IF NOT EXISTS importance_tag TEXT;

-- Add check constraint for valid importance_tag values
ALTER TABLE feature_requests 
ADD CONSTRAINT feature_requests_importance_tag_check 
CHECK (importance_tag IN ('must_have', 'nice_to_have', 'maturity'));

-- Add comment explaining the column
COMMENT ON COLUMN feature_requests.importance_tag IS 'Classification of request importance: must_have (critical for operations), nice_to_have (enhances experience), maturity (long-term improvement)';

-- Create index for better query performance on importance_tag
CREATE INDEX IF NOT EXISTS idx_feature_requests_importance_tag 
ON feature_requests(importance_tag) 
WHERE importance_tag IS NOT NULL;

-- Create composite index for super admin queries (facility + status + importance)
CREATE INDEX IF NOT EXISTS idx_feature_requests_admin_view 
ON feature_requests(facility_id, status, importance_tag, created_at DESC);

-- Add index for page tracking
CREATE INDEX IF NOT EXISTS idx_feature_requests_page_url 
ON feature_requests(page_url) 
WHERE page_url IS NOT NULL;