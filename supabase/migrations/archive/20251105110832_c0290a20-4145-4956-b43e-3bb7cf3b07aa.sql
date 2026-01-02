-- Update visits status check constraint to include all patient journey stages
ALTER TABLE visits DROP CONSTRAINT IF EXISTS visits_status_check;

ALTER TABLE visits ADD CONSTRAINT visits_status_check 
CHECK (status IN (
  'registered',
  'at_triage',
  'vitals_taken',
  'paying_consultation',
  'with_doctor',
  'paying_diagnosis',
  'at_lab',
  'at_imaging',
  'paying_pharmacy',
  'at_pharmacy',
  'admitted',
  'discharged',
  'cancelled'
));