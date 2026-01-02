-- Add assessment tracking fields to visits table
ALTER TABLE visits 
ADD COLUMN IF NOT EXISTS assessment_completed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS assessed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS assessed_by UUID REFERENCES users(id);

-- Create index for efficient querying of unassessed patients
CREATE INDEX IF NOT EXISTS idx_visits_assessment_tracking 
ON visits(facility_id, assigned_doctor, assessment_completed, status) 
WHERE assessment_completed = FALSE;

-- Backfill existing data: Mark visits as assessed if they have structured clinical data
UPDATE visits 
SET 
  assessment_completed = TRUE,
  assessed_at = updated_at
WHERE 
  (provider ILIKE '%assessment completed%' 
   OR clinical_notes IS NOT NULL AND clinical_notes != ''
   OR visit_notes IS NOT NULL AND visit_notes::text LIKE '%structuredAssessment%')
  AND assessment_completed = FALSE;

COMMENT ON COLUMN visits.assessment_completed IS 'Indicates if clinical assessment has been completed by a doctor';
COMMENT ON COLUMN visits.assessed_at IS 'Timestamp when clinical assessment was completed';
COMMENT ON COLUMN visits.assessed_by IS 'User ID of the doctor who completed the assessment';