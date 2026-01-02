-- Update journey tracking to support start_time and end_time per stage
-- This allows calculating wait times for each service separately

-- Update the append_journey_stage function to track start and end times
CREATE OR REPLACE FUNCTION append_journey_stage(
  p_visit_id uuid,
  p_stage text,
  p_user_id uuid DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_current_timeline jsonb;
  v_stages jsonb := '[]'::jsonb;
  v_last_stage jsonb;
  v_new_stage jsonb;
  v_last_index integer;
  v_last_arrived timestamptz;
  v_now timestamptz := now();
  v_wait_minutes numeric;
BEGIN
  -- Get current timeline
  SELECT journey_timeline INTO v_current_timeline
  FROM visits
  WHERE id = p_visit_id;

  -- Initialize timeline container when null
  IF v_current_timeline IS NOT NULL THEN
    v_stages := COALESCE(v_current_timeline->'stages', '[]'::jsonb);
  END IF;

  -- Close the previously active stage so its duration reflects the
  -- actual time spent at that location.
  IF jsonb_array_length(v_stages) > 0 THEN
    v_last_index := jsonb_array_length(v_stages) - 1;
    v_last_stage := v_stages->v_last_index;

    IF (v_last_stage->>'completed_at') IS NULL THEN
      v_last_arrived := COALESCE(
        (v_last_stage->>'arrived_at')::timestamptz,
        (v_last_stage->>'start_time')::timestamptz,
        v_now
      );

      v_wait_minutes := EXTRACT(EPOCH FROM (v_now - v_last_arrived)) / 60;

      v_last_stage := jsonb_set(v_last_stage, '{completed_at}', to_jsonb(v_now));
      v_last_stage := jsonb_set(v_last_stage, '{end_time}', to_jsonb(v_now));
      v_last_stage := jsonb_set(v_last_stage, '{wait_time_minutes}', to_jsonb(v_wait_minutes));

      IF p_user_id IS NOT NULL THEN
        v_last_stage := jsonb_set(v_last_stage, '{completed_by}', to_jsonb(p_user_id::text));
      END IF;

      v_stages := jsonb_set(v_stages, ARRAY[v_last_index::text], v_last_stage);
    END IF;
  END IF;

  -- Add the new active stage with a fresh arrival timestamp
  v_new_stage := jsonb_build_object(
    'stage', p_stage,
    'arrived_at', v_now,
    'completed_at', NULL,
    'wait_time_minutes', NULL,
    'completed_by', p_user_id,
    'start_time', v_now,
    'end_time', NULL
  );

  v_stages := v_stages || jsonb_build_array(v_new_stage);

  -- Update visit with refreshed timeline and status metadata
  UPDATE visits
  SET
    journey_timeline = jsonb_build_object('stages', v_stages),
    status = p_stage,
    status_updated_at = v_now
  WHERE id = p_visit_id;
END;
$$ LANGUAGE plpgsql;

-- Function to get current wait time for a specific stage
CREATE OR REPLACE FUNCTION get_current_stage_wait_time(
  p_visit_id uuid,
  p_current_stage text
) RETURNS integer AS $$
DECLARE
  v_timeline jsonb;
  v_stages jsonb;
  v_last_stage jsonb;
  v_last_arrived timestamptz;
  v_wait_minutes integer := 0;
BEGIN
  -- Get current timeline
  SELECT journey_timeline INTO v_timeline
  FROM visits
  WHERE id = p_visit_id;

  IF v_timeline IS NULL THEN
    RETURN 0;
  END IF;

  v_stages := COALESCE(v_timeline->'stages', '[]'::jsonb);

  IF jsonb_array_length(v_stages) = 0 THEN
    RETURN 0;
  END IF;

  v_last_stage := v_stages->-1;

  IF v_last_stage->>'completed_at' IS NOT NULL THEN
    RETURN 0;
  END IF;

  IF v_last_stage->>'stage' <> p_current_stage THEN
    RETURN 0;
  END IF;

  v_last_arrived := COALESCE(
    (v_last_stage->>'arrived_at')::timestamptz,
    (v_last_stage->>'start_time')::timestamptz
  );

  IF v_last_arrived IS NULL THEN
    RETURN 0;
  END IF;

  v_wait_minutes := FLOOR(EXTRACT(EPOCH FROM (now() - v_last_arrived)) / 60);

  RETURN GREATEST(v_wait_minutes, 0);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION append_journey_stage IS 'Track patient journey stages with arrived_at/completed_at and calculated wait_time per stage';
COMMENT ON FUNCTION get_current_stage_wait_time IS 'Get current wait time for the active stage in minutes using arrival timestamps';