-- Add importance tag to feature requests
ALTER TABLE public.feature_requests
ADD COLUMN IF NOT EXISTS importance_tag text NOT NULL DEFAULT 'nice_to_have'
  CHECK (importance_tag IN ('must_have', 'nice_to_have', 'maturity'));

COMMENT ON COLUMN public.feature_requests.importance_tag IS 'User-provided importance tag (Must Have, Nice to Have, or Maturity).';
