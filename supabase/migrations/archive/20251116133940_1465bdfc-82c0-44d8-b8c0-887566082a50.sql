-- Drop and recreate with IMMUTABLE for index support
DROP VIEW IF EXISTS visits_with_current_stage CASCADE;
DROP FUNCTION IF EXISTS get_current_journey_stage(jsonb) CASCADE;

-- Create function as IMMUTABLE so it can be used in indexes
CREATE OR REPLACE FUNCTION get_current_journey_stage(timeline jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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

-- Recreate view with security_invoker
CREATE VIEW visits_with_current_stage 
WITH (security_invoker = true) AS
SELECT 
  v.*,
  get_current_journey_stage(v.journey_timeline) as current_journey_stage
FROM visits v;

-- Add helpful indexes for common journey stage queries
CREATE INDEX IF NOT EXISTS idx_visits_current_stage_facility 
ON visits(facility_id, (get_current_journey_stage(journey_timeline)));

COMMENT ON FUNCTION get_current_journey_stage IS 
'Extracts the current (most recent) patient journey stage from the journey_timeline JSONB field. Returns NULL if timeline is empty or invalid.';

COMMENT ON VIEW visits_with_current_stage IS 
'View that includes the current journey stage extracted from journey_timeline for easier filtering in dashboards.';