-- Fix security warnings: Set search_path for new functions

-- Update append_journey_stage with secure search_path
CREATE OR REPLACE FUNCTION append_journey_stage(
  p_visit_id uuid,
  p_stage text,
  p_user_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_timeline jsonb;
  v_stages jsonb := '[]'::jsonb;
  v_last_stage jsonb;
  v_stage_exists boolean;
  v_last_index integer;
  v_last_arrived timestamptz;
  v_last_completed timestamptz;
  v_start_time timestamptz;
  v_now timestamptz := now();
  v_wait_minutes numeric;
BEGIN
  -- Get current timeline
  SELECT journey_timeline INTO v_current_timeline
  FROM visits
  WHERE id = p_visit_id;

  -- Initialize if null
  IF v_current_timeline IS NOT NULL THEN
    v_stages := COALESCE(v_current_timeline->'stages', '[]'::jsonb);
  END IF;

  -- Check if this stage already exists (completed)
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_stages) AS stage
    WHERE stage->>'stage' = p_stage
    AND stage->>'end_time' IS NOT NULL
  ) INTO v_stage_exists;

  -- If stage already completed, don't add it again
  IF v_stage_exists THEN
    RETURN;
  END IF;

  v_start_time := v_now;

  -- Close any active previous stage and capture its duration
  IF jsonb_array_length(v_stages) > 0 THEN
    v_last_index := jsonb_array_length(v_stages) - 1;
    v_last_stage := v_stages->v_last_index;

    v_last_completed := COALESCE(
      (v_last_stage->>'completed_at')::timestamptz,
      (v_last_stage->>'end_time')::timestamptz
    );

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

      v_last_completed := v_now;
    END IF;

    v_start_time := COALESCE(v_last_completed, v_now);
  END IF;

  -- Add new active stage with start time anchored to previous completion
  v_stages := v_stages || jsonb_build_array(
    jsonb_build_object(
      'stage', p_stage,
      'arrived_at', v_start_time,
      'completed_at', NULL,
      'wait_time_minutes', NULL,
      'completed_by', CASE WHEN p_user_id IS NOT NULL THEN to_jsonb(p_user_id::text) ELSE 'null'::jsonb END,
      'start_time', v_start_time,
      'end_time', NULL
    )
  );

  -- Update visit with new timeline
  UPDATE visits
  SET
    journey_timeline = jsonb_build_object('stages', v_stages),
    status = p_stage,
    status_updated_at = v_now
  WHERE id = p_visit_id;
END;
$$;

-- Update get_current_stage_wait_time with secure search_path
CREATE OR REPLACE FUNCTION get_current_stage_wait_time(
  p_visit_id uuid,
  p_current_stage text
) RETURNS integer 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_timeline jsonb;
  v_stages jsonb;
  v_last_stage jsonb;
  v_last_end_time timestamptz;
  v_wait_minutes integer;
BEGIN
  -- Get current timeline
  SELECT journey_timeline INTO v_timeline
  FROM visits
  WHERE id = p_visit_id;
  
  IF v_timeline IS NULL THEN
    RETURN 0;
  END IF;
  
  v_stages := v_timeline->'stages';
  
  IF jsonb_array_length(v_stages) = 0 THEN
    RETURN 0;
  END IF;
  
  -- Get last completed stage
  v_last_stage := v_stages->-1;
  v_last_end_time := (v_last_stage->>'end_time')::timestamptz;
  
  IF v_last_end_time IS NULL THEN
    RETURN 0;
  END IF;
  
  -- Calculate wait time from last stage end to now
  v_wait_minutes := EXTRACT(EPOCH FROM (now() - v_last_end_time)) / 60;
  
  RETURN v_wait_minutes::integer;
END;
$$;