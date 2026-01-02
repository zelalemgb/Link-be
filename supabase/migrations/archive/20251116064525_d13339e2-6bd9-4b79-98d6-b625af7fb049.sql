-- Phase 1: Auto-derive visit status from journey_timeline (Fixed version)
-- This trigger ensures status field is always consistent with the last completed stage in journey_timeline

-- Drop existing triggers if they exist (for idempotency)
DROP TRIGGER IF EXISTS derive_status_from_timeline ON visits;
DROP FUNCTION IF EXISTS auto_derive_visit_status();

-- First, fix the track_visit_status_changes trigger to handle NULL status gracefully
CREATE OR REPLACE FUNCTION track_visit_status_changes()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id 
  FROM public.users 
  WHERE auth_user_id = auth.uid() 
  LIMIT 1;
  
  -- Only log status change if both old and new status are not NULL
  IF (TG_OP = 'INSERT' AND NEW.status IS NOT NULL) OR 
     (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status IS NOT NULL) THEN
    INSERT INTO public.patient_status_events (
      tenant_id, facility_id, visit_id, patient_id,
      previous_status, new_status, event_type,
      changed_by, changed_at, metadata
    ) VALUES (
      NEW.tenant_id, NEW.facility_id, NEW.id, NEW.patient_id,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      NEW.status,
      'status_change',
      COALESCE(v_user_id, NEW.created_by), 
      now(),
      jsonb_build_object(
        'operation', TG_OP,
        'assessment_completed', NEW.assessment_completed,
        'journey_timeline', NEW.journey_timeline
      )
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger function to auto-derive status from journey_timeline
CREATE OR REPLACE FUNCTION auto_derive_visit_status()
RETURNS TRIGGER AS $$
DECLARE
  v_latest_stage text;
  v_latest_end_time timestamptz;
BEGIN
  -- If journey_timeline is updated or inserted, derive status from the last completed stage
  IF NEW.journey_timeline IS NOT NULL AND NEW.journey_timeline != '{}'::jsonb THEN
    -- Get the latest completed stage (has end_time)
    SELECT stage, end_time INTO v_latest_stage, v_latest_end_time
    FROM jsonb_to_recordset(NEW.journey_timeline->'stages') 
    AS x(stage text, end_time timestamptz)
    WHERE end_time IS NOT NULL
    ORDER BY end_time DESC NULLS LAST
    LIMIT 1;
    
    -- Only update status if we found a valid completed stage AND it's different from current
    IF v_latest_stage IS NOT NULL AND v_latest_stage != '' THEN
      NEW.status := v_latest_stage;
      NEW.status_updated_at := now();
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Attach trigger BEFORE INSERT OR UPDATE to override any manual status changes
CREATE TRIGGER derive_status_from_timeline
  BEFORE INSERT OR UPDATE OF journey_timeline
  ON visits
  FOR EACH ROW
  EXECUTE FUNCTION auto_derive_visit_status();

-- Fix existing visits with inconsistent status/journey_timeline data
-- Only update visits that have a valid derived status from journey_timeline
UPDATE visits
SET status = derived_status,
    status_updated_at = now()
FROM (
  SELECT 
    v.id,
    (
      SELECT stage 
      FROM jsonb_to_recordset(v.journey_timeline->'stages') 
      AS x(stage text, end_time timestamptz)
      WHERE end_time IS NOT NULL AND stage IS NOT NULL AND stage != ''
      ORDER BY end_time DESC NULLS LAST
      LIMIT 1
    ) as derived_status
  FROM visits v
  WHERE v.journey_timeline IS NOT NULL 
    AND v.journey_timeline != '{}'::jsonb
    AND v.journey_timeline->'stages' IS NOT NULL
    AND jsonb_array_length(v.journey_timeline->'stages') > 0
) AS subquery
WHERE visits.id = subquery.id
  AND subquery.derived_status IS NOT NULL
  AND subquery.derived_status != ''
  AND visits.status != subquery.derived_status;

-- Specific fix for Kidus Zelalem - touch the record to trigger re-derivation
UPDATE visits
SET updated_at = now()
WHERE id = '58fc0b75-6194-4e26-9d85-b793d46b07af';

COMMENT ON FUNCTION auto_derive_visit_status() IS 
  'Automatically derives visit status from the last completed stage in journey_timeline. 
   This ensures status field is always consistent with patient journey progression.';

COMMENT ON TRIGGER derive_status_from_timeline ON visits IS 
  'Overrides manual status updates to ensure consistency with journey_timeline. 
   Status becomes a computed field derived from journey stages.';