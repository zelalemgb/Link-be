-- Create a function to backfill facility_id for feature_requests
CREATE OR REPLACE FUNCTION backfill_feature_requests_facility_id()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count integer;
BEGIN
  -- Update feature_requests with missing facility_id
  UPDATE feature_requests fr
  SET facility_id = u.facility_id
  FROM users u
  WHERE fr.user_id = u.id 
    AND fr.facility_id IS NULL;
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  
  RETURN updated_count;
END;
$$;

-- Run the backfill immediately
SELECT backfill_feature_requests_facility_id() as updated_records_count;

-- Drop the function after use (one-time operation)
DROP FUNCTION IF EXISTS backfill_feature_requests_facility_id();