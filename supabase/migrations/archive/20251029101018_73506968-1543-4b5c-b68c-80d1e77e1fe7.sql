-- Add result_type and qualitative_options columns to lab_test_master
ALTER TABLE public.lab_test_master
ADD COLUMN result_type text NOT NULL DEFAULT 'quantitative' CHECK (result_type IN ('qualitative', 'quantitative')),
ADD COLUMN qualitative_options text[] DEFAULT NULL;

COMMENT ON COLUMN public.lab_test_master.result_type IS 'Type of result: qualitative (dropdown) or quantitative (numeric)';
COMMENT ON COLUMN public.lab_test_master.qualitative_options IS 'Array of options for qualitative tests (e.g., ["+VE", "-VE", "Indeterminate"])';

-- Update existing tests with appropriate result types

-- Rapid tests - Qualitative
UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['+VE (Positive)', '-VE (Negative)', 'Indeterminate']
WHERE test_name IN ('HIV Rapid Test', 'HBsAg', 'HCV', 'VDRL', 'RPR', 'Malaria RDT', 'H. Pylori', 'Pregnancy Test');

-- Urine Analysis qualitative components
UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['Yellow', 'Pale Yellow', 'Dark Yellow', 'Amber', 'Red', 'Brown', 'Clear', 'Cloudy']
WHERE test_name = 'Urine Color';

UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['Clear', 'Slightly Cloudy', 'Cloudy', 'Turbid']
WHERE test_name = 'Urine Appearance';

UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['Negative', 'Trace', '+', '++', '+++', '++++']
WHERE test_name IN ('Urine Protein', 'Urine Glucose', 'Urine Ketones', 'Urine Blood');

UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['Negative', 'Small', 'Moderate', 'Large']
WHERE test_name = 'Urine Bilirubin';

UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['Negative', 'Positive']
WHERE test_name IN ('Urine Nitrite', 'Urine Leukocyte Esterase');

-- Blood group - Qualitative
UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
WHERE test_name = 'Blood Group';

-- Stool tests - mostly qualitative
UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['Brown', 'Green', 'Yellow', 'Black', 'Red', 'Clay-colored']
WHERE test_name = 'Stool Color';

UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['Formed', 'Semi-formed', 'Loose', 'Watery', 'Hard']
WHERE test_name = 'Stool Consistency';

UPDATE public.lab_test_master 
SET result_type = 'qualitative',
    qualitative_options = ARRAY['Negative', 'Positive']
WHERE test_name IN ('Stool Occult Blood', 'Ova', 'Parasites', 'Cysts');

-- All other tests remain quantitative (default)