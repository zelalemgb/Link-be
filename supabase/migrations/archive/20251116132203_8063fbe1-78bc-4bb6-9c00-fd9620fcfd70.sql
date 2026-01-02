-- Create advance_patient_stage RPC function with security enforcement
-- This function enforces stage ownership and valid transitions server-side

CREATE OR REPLACE FUNCTION public.advance_patient_stage(
  p_visit_id uuid,
  p_next_stage text,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_stage text;
  v_user_role text;
  v_caller_user_id uuid;
  v_timeline jsonb;
  v_stages jsonb;
  v_allowed_roles text[];
  v_is_authorized boolean := false;
BEGIN
  -- Get the calling user's ID from auth context if not provided
  IF p_user_id IS NULL THEN
    SELECT id INTO v_caller_user_id
    FROM public.users
    WHERE auth_user_id = auth.uid()
    LIMIT 1;
  ELSE
    v_caller_user_id := p_user_id;
  END IF;

  IF v_caller_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User not found or not authenticated'
    );
  END IF;

  -- Get the user's role
  SELECT user_role INTO v_user_role
  FROM public.users
  WHERE id = v_caller_user_id;

  -- Super admins can advance any stage
  IF v_user_role = 'super_admin' THEN
    v_is_authorized := true;
  ELSE
    -- Get current stage from journey_timeline
    SELECT journey_timeline INTO v_timeline
    FROM public.visits
    WHERE id = p_visit_id;

    IF v_timeline IS NOT NULL AND v_timeline->'stages' IS NOT NULL THEN
      v_stages := v_timeline->'stages';
      IF jsonb_array_length(v_stages) > 0 THEN
        v_current_stage := (v_stages->-1)->>'stage';
      END IF;
    END IF;

    -- Fallback to status field if timeline is empty
    IF v_current_stage IS NULL THEN
      SELECT status INTO v_current_stage
      FROM public.visits
      WHERE id = p_visit_id;
    END IF;

    -- Define stage ownership rules (must match client-side rules)
    CASE v_current_stage
      WHEN 'registered' THEN
        v_allowed_roles := ARRAY['receptionist'];
      WHEN 'paying_consultation' THEN
        v_allowed_roles := ARRAY['receptionist', 'cashier'];
      WHEN 'at_triage', 'vitals_taken' THEN
        v_allowed_roles := ARRAY['nurse'];
      WHEN 'with_doctor' THEN
        v_allowed_roles := ARRAY['doctor'];
      WHEN 'paying_diagnosis', 'paying_pharmacy' THEN
        v_allowed_roles := ARRAY['cashier'];
      WHEN 'at_lab' THEN
        v_allowed_roles := ARRAY['lab_technician'];
      WHEN 'at_imaging' THEN
        v_allowed_roles := ARRAY['imaging_technician'];
      WHEN 'at_pharmacy' THEN
        v_allowed_roles := ARRAY['pharmacist'];
      WHEN 'admitted' THEN
        v_allowed_roles := ARRAY['inpatient_nurse', 'doctor'];
      WHEN 'discharged' THEN
        -- Terminal state - no one can advance
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Cannot advance from discharged state'
        );
      ELSE
        v_allowed_roles := ARRAY[]::text[];
    END CASE;

    -- Check if user's role is in allowed roles
    v_is_authorized := v_user_role = ANY(v_allowed_roles);
  END IF;

  -- Reject if not authorized
  IF NOT v_is_authorized THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('User role "%s" is not authorized to advance from stage "%s"', v_user_role, v_current_stage)
    );
  END IF;

  -- Validate state transition (basic validation - can be expanded)
  -- This ensures we're following logical flow
  CASE v_current_stage
    WHEN 'registered' THEN
      IF p_next_stage NOT IN ('paying_consultation', 'at_triage', 'vitals_taken') THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', format('Invalid transition from %s to %s', v_current_stage, p_next_stage)
        );
      END IF;
    WHEN 'paying_consultation' THEN
      IF p_next_stage NOT IN ('at_triage', 'vitals_taken') THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', format('Invalid transition from %s to %s', v_current_stage, p_next_stage)
        );
      END IF;
    -- Add more transition rules as needed
    ELSE
      -- Allow most transitions for now
      NULL;
  END CASE;

  -- Execute the stage advancement using existing append_journey_stage
  PERFORM public.append_journey_stage(p_visit_id, p_next_stage, v_caller_user_id);

  RETURN jsonb_build_object(
    'success', true,
    'new_stage', p_next_stage,
    'previous_stage', v_current_stage
  );
END;
$$;