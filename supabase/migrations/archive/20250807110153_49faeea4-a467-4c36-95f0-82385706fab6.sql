-- Add proper status field to visits table
ALTER TABLE visits ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'waiting';

-- Add status updated timestamp
ALTER TABLE visits ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- Create function to update status timestamp
CREATE OR REPLACE FUNCTION update_visit_status_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  -- Update status_updated_at when status changes
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.status_updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for status updates
DROP TRIGGER IF EXISTS trigger_update_visit_status_timestamp ON visits;
CREATE TRIGGER trigger_update_visit_status_timestamp
  BEFORE UPDATE ON visits
  FOR EACH ROW
  EXECUTE FUNCTION update_visit_status_timestamp();

-- Update existing visits to have proper status based on their current state
UPDATE visits SET 
  status = CASE
    WHEN visit_notes IS NOT NULL AND visit_notes != '' THEN 'completed'
    WHEN temperature IS NOT NULL OR weight IS NOT NULL OR blood_pressure IS NOT NULL THEN 'in_progress'
    ELSE 'waiting'
  END,
  status_updated_at = updated_at
WHERE status IS NULL OR status = 'waiting';