-- Update visit status to reflect patient journey stages
-- First, update all NULL and existing statuses
UPDATE visits 
SET status = CASE 
  WHEN status IS NULL THEN 'registered'
  WHEN status = 'waiting' THEN 'registered'
  WHEN status = 'triaged' THEN 'vitals_taken'
  WHEN status = 'in_progress' THEN 'with_doctor'
  WHEN status = 'completed' THEN 'discharged'
  WHEN status = 'cancelled' THEN 'cancelled'
  ELSE 'registered'
END;

-- Drop the old check constraint if it exists
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_status_check;

-- Add new check constraint with updated status values
ALTER TABLE visits ADD CONSTRAINT visits_status_check 
CHECK (status IN ('registered', 'vitals_taken', 'with_doctor', 'laboratory', 'pharmacy', 'discharged', 'cancelled'));