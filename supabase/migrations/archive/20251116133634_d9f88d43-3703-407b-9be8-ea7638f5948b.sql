-- Create function to extract current journey stage from journey_timeline
CREATE OR REPLACE FUNCTION get_current_journey_stage(timeline jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  stages jsonb;
  last_stage jsonb;
BEGIN
  -- Return null if timeline is null or empty
  IF timeline IS NULL OR timeline = 'null'::jsonb THEN
    RETURN NULL;
  END IF;
  
  -- Extract stages array
  stages := timeline->'stages';
  
  -- Return null if no stages
  IF stages IS NULL OR jsonb_array_length(stages) = 0 THEN
    RETURN NULL;
  END IF;
  
  -- Get the last stage (most recent)
  last_stage := stages->-1;
  
  -- Return the stage name
  RETURN last_stage->>'stage';
END;
$$;

-- Create index on visits for journey_timeline to improve query performance
CREATE INDEX IF NOT EXISTS idx_visits_journey_timeline 
ON visits USING gin(journey_timeline);

-- Add comments for documentation
COMMENT ON FUNCTION get_current_journey_stage IS 
'Extracts the current (most recent) patient journey stage from the journey_timeline JSONB field. Returns NULL if timeline is empty or invalid.';

-- Create a view that includes current journey stage for easier querying
CREATE OR REPLACE VIEW visits_with_current_stage AS
SELECT 
  v.*,
  get_current_journey_stage(v.journey_timeline) as current_journey_stage
FROM visits v;

COMMENT ON VIEW visits_with_current_stage IS 
'View that includes the current journey stage extracted from journey_timeline for easier filtering in dashboards.';