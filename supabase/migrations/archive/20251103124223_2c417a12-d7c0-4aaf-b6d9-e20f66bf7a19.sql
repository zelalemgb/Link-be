-- Update lab_test_master to support multiple sample types if needed
-- Check if sample_type is already an array, if not, we'll keep it as text
-- and handle multiple types with comma separation

-- Add comment to clarify sample_type usage
COMMENT ON COLUMN lab_test_master.sample_type IS 'Sample type(s) required for this test. Multiple types can be comma-separated (e.g., "EDTA Whole Blood,Serum")';

-- Add some default sample type mappings for common tests if they don't exist
-- This helps ensure tests have proper sample types defined

-- Update existing tests to have proper sample types if they're missing or generic
UPDATE lab_test_master 
SET sample_type = 'EDTA Whole Blood'
WHERE (test_name ILIKE '%CBC%' OR test_name ILIKE '%hemoglobin%' OR test_name ILIKE '%hematocrit%' OR test_name ILIKE '%WBC%' OR test_name ILIKE '%platelet%')
AND (sample_type IS NULL OR sample_type = '' OR sample_type = 'Blood');

UPDATE lab_test_master 
SET sample_type = 'Serum'
WHERE (test_name ILIKE '%glucose%' OR test_name ILIKE '%creatinine%' OR test_name ILIKE '%ALT%' OR test_name ILIKE '%AST%' OR test_name ILIKE '%bilirubin%' OR test_name ILIKE '%lipid%' OR test_name ILIKE '%cholesterol%')
AND (sample_type IS NULL OR sample_type = '' OR sample_type = 'Blood');

UPDATE lab_test_master 
SET sample_type = 'Citrate Plasma'
WHERE (test_name ILIKE '%PT%' OR test_name ILIKE '%PTT%' OR test_name ILIKE '%INR%' OR test_name ILIKE '%coagulation%')
AND (sample_type IS NULL OR sample_type = '' OR sample_type = 'Blood');

UPDATE lab_test_master 
SET sample_type = 'Urine'
WHERE test_name ILIKE '%urine%' OR test_name ILIKE '%urinalysis%'
AND (sample_type IS NULL OR sample_type = '');

UPDATE lab_test_master 
SET sample_type = 'Swab/Culture Media'
WHERE test_name ILIKE '%culture%' OR test_name ILIKE '%sensitivity%'
AND (sample_type IS NULL OR sample_type = '');