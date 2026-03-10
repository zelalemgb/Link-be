-- Add Africa's Talking short-code column to facilities
-- Used to route inbound SMS to the correct facility
ALTER TABLE public.facilities
  ADD COLUMN IF NOT EXISTS at_short_code text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_facilities_at_short_code
  ON public.facilities(at_short_code)
  WHERE at_short_code IS NOT NULL;

COMMENT ON COLUMN public.facilities.at_short_code IS
  'Africa''s Talking registered shortcode or virtual number for this facility (e.g. 10727)';
