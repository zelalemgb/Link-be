-- Add admission details columns to visits table
ALTER TABLE visits 
ADD COLUMN IF NOT EXISTS admission_ward text,
ADD COLUMN IF NOT EXISTS admission_bed text,
ADD COLUMN IF NOT EXISTS admitted_at timestamp with time zone;

-- Add comment for documentation
COMMENT ON COLUMN visits.admission_ward IS 'Ward assigned when patient is admitted to inpatient care';
COMMENT ON COLUMN visits.admission_bed IS 'Bed number assigned when patient is admitted to inpatient care';
COMMENT ON COLUMN visits.admitted_at IS 'Timestamp when patient was admitted to inpatient care';