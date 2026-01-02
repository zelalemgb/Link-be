-- Create function to refresh nurse dashboard queue on vital updates
CREATE OR REPLACE FUNCTION refresh_nurse_queue_on_vital_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Only refresh if vital signs were actually changed
  IF (NEW.temperature IS DISTINCT FROM OLD.temperature OR
      NEW.blood_pressure IS DISTINCT FROM OLD.blood_pressure OR
      NEW.heart_rate IS DISTINCT FROM OLD.heart_rate OR
      NEW.respiratory_rate IS DISTINCT FROM OLD.respiratory_rate OR
      NEW.oxygen_saturation IS DISTINCT FROM OLD.oxygen_saturation OR
      NEW.weight IS DISTINCT FROM OLD.weight OR
      NEW.triage_triggers IS DISTINCT FROM OLD.triage_triggers OR
      NEW.status IS DISTINCT FROM OLD.status) THEN
    
    -- Refresh the materialized view concurrently (non-blocking)
    REFRESH MATERIALIZED VIEW CONCURRENTLY nurse_dashboard_queue;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on visits table for vital updates
DROP TRIGGER IF EXISTS trigger_refresh_nurse_queue_on_vital_update ON visits;
CREATE TRIGGER trigger_refresh_nurse_queue_on_vital_update
AFTER UPDATE ON visits
FOR EACH ROW
EXECUTE FUNCTION refresh_nurse_queue_on_vital_update();

-- Also refresh on INSERT (new patients)
DROP TRIGGER IF EXISTS trigger_refresh_nurse_queue_on_insert ON visits;
CREATE TRIGGER trigger_refresh_nurse_queue_on_insert
AFTER INSERT ON visits
FOR EACH ROW
EXECUTE FUNCTION refresh_nurse_queue_on_vital_update();