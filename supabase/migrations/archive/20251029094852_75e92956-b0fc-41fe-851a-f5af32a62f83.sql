-- Create laboratory test master table
CREATE TABLE IF NOT EXISTS public.lab_test_master (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_code TEXT NOT NULL UNIQUE,
  test_name TEXT NOT NULL,
  category TEXT NOT NULL,
  panel_name TEXT,
  reference_range_male TEXT,
  reference_range_female TEXT,
  reference_range_general TEXT,
  unit_of_measure TEXT NOT NULL,
  sample_type TEXT NOT NULL,
  critical_low TEXT,
  critical_high TEXT,
  method TEXT,
  turnaround_time_hours INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Add index for faster lookups
CREATE INDEX idx_lab_test_master_code ON public.lab_test_master(test_code);
CREATE INDEX idx_lab_test_master_category ON public.lab_test_master(category);
CREATE INDEX idx_lab_test_master_panel ON public.lab_test_master(panel_name);

-- Enable RLS
ALTER TABLE public.lab_test_master ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read the master test data
CREATE POLICY "Allow all authenticated users to view lab test master"
  ON public.lab_test_master
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only super admins can modify the master data
CREATE POLICY "Super admins can manage lab test master"
  ON public.lab_test_master
  FOR ALL
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

-- Insert comprehensive laboratory test data based on clinical standards

-- HEMATOLOGY TESTS
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_male, reference_range_female, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('HGB', 'Hemoglobin', 'Hematology', 'Complete Blood Count', '13.5-17.5', '12.0-15.5', 'g/dL', 'Whole Blood (EDTA)', '7.0', '20.0'),
('HCT', 'Hematocrit', 'Hematology', 'Complete Blood Count', '41-50', '36-44', '%', 'Whole Blood (EDTA)', '20', '60'),
('WBC', 'White Blood Cell Count', 'Hematology', 'Complete Blood Count', '4.0-11.0', '4.0-11.0', 'x10³/µL', 'Whole Blood (EDTA)', '2.0', '30.0'),
('RBC', 'Red Blood Cell Count', 'Hematology', 'Complete Blood Count', '4.5-5.5', '4.0-5.0', 'x10⁶/µL', 'Whole Blood (EDTA)', '2.0', '7.0'),
('PLT', 'Platelet Count', 'Hematology', 'Complete Blood Count', '150-450', '150-450', 'x10³/µL', 'Whole Blood (EDTA)', '20', '1000'),
('MCV', 'Mean Corpuscular Volume', 'Hematology', 'Complete Blood Count', '80-100', '80-100', 'fL', 'Whole Blood (EDTA)', NULL, NULL),
('MCH', 'Mean Corpuscular Hemoglobin', 'Hematology', 'Complete Blood Count', '27-31', '27-31', 'pg', 'Whole Blood (EDTA)', NULL, NULL),
('MCHC', 'Mean Corpuscular Hemoglobin Concentration', 'Hematology', 'Complete Blood Count', '32-36', '32-36', 'g/dL', 'Whole Blood (EDTA)', NULL, NULL),
('RDW', 'Red Cell Distribution Width', 'Hematology', 'Complete Blood Count', '11.5-14.5', '11.5-14.5', '%', 'Whole Blood (EDTA)', NULL, NULL),
('NEUT', 'Neutrophils', 'Hematology', 'Complete Blood Count', '40-70', '40-70', '%', 'Whole Blood (EDTA)', NULL, NULL),
('LYMPH', 'Lymphocytes', 'Hematology', 'Complete Blood Count', '20-40', '20-40', '%', 'Whole Blood (EDTA)', NULL, NULL),
('MONO', 'Monocytes', 'Hematology', 'Complete Blood Count', '2-8', '2-8', '%', 'Whole Blood (EDTA)', NULL, NULL),
('EOS', 'Eosinophils', 'Hematology', 'Complete Blood Count', '1-4', '1-4', '%', 'Whole Blood (EDTA)', NULL, NULL),
('BASO', 'Basophils', 'Hematology', 'Complete Blood Count', '0-1', '0-1', '%', 'Whole Blood (EDTA)', NULL, NULL),
('ESR', 'Erythrocyte Sedimentation Rate', 'Hematology', NULL, '0-15', '0-20', 'mm/hr', 'Whole Blood (EDTA)', NULL, NULL),
('RETIC', 'Reticulocyte Count', 'Hematology', NULL, '0.5-2.5', '0.5-2.5', '%', 'Whole Blood (EDTA)', NULL, NULL);

-- CHEMISTRY - ELECTROLYTES & KIDNEY FUNCTION
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('NA', 'Sodium', 'Chemistry', 'Basic Metabolic Panel', '136-145', 'mEq/L', 'Serum', '120', '160'),
('K', 'Potassium', 'Chemistry', 'Basic Metabolic Panel', '3.5-5.0', 'mEq/L', 'Serum', '2.5', '6.5'),
('CL', 'Chloride', 'Chemistry', 'Basic Metabolic Panel', '98-106', 'mEq/L', 'Serum', '80', '115'),
('CO2', 'Carbon Dioxide (Bicarbonate)', 'Chemistry', 'Basic Metabolic Panel', '22-29', 'mEq/L', 'Serum', '10', '40'),
('BUN', 'Blood Urea Nitrogen', 'Chemistry', 'Basic Metabolic Panel', '7-20', 'mg/dL', 'Serum', NULL, '100'),
('CREAT', 'Creatinine', 'Chemistry', 'Basic Metabolic Panel', '0.7-1.3', 'mg/dL', 'Serum', NULL, '10.0'),
('GLU', 'Glucose', 'Chemistry', 'Basic Metabolic Panel', '70-100', 'mg/dL', 'Serum/Plasma', '40', '500'),
('CA', 'Calcium', 'Chemistry', 'Comprehensive Metabolic Panel', '8.5-10.5', 'mg/dL', 'Serum', '6.0', '13.0'),
('MG', 'Magnesium', 'Chemistry', NULL, '1.7-2.2', 'mg/dL', 'Serum', '1.0', '4.0'),
('PHOS', 'Phosphorus', 'Chemistry', NULL, '2.5-4.5', 'mg/dL', 'Serum', '1.0', '8.0'),
('URIC', 'Uric Acid', 'Chemistry', NULL, '3.5-7.2', 'mg/dL', 'Serum', NULL, NULL);

-- LIVER FUNCTION TESTS
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('ALT', 'Alanine Aminotransferase (SGPT)', 'Chemistry', 'Liver Function Panel', '7-56', 'U/L', 'Serum', NULL, '1000'),
('AST', 'Aspartate Aminotransferase (SGOT)', 'Chemistry', 'Liver Function Panel', '10-40', 'U/L', 'Serum', NULL, '1000'),
('ALP', 'Alkaline Phosphatase', 'Chemistry', 'Liver Function Panel', '44-147', 'U/L', 'Serum', NULL, '500'),
('TBILI', 'Total Bilirubin', 'Chemistry', 'Liver Function Panel', '0.3-1.2', 'mg/dL', 'Serum', NULL, '15.0'),
('DBILI', 'Direct Bilirubin', 'Chemistry', 'Liver Function Panel', '0.0-0.3', 'mg/dL', 'Serum', NULL, NULL),
('ALB', 'Albumin', 'Chemistry', 'Liver Function Panel', '3.5-5.5', 'g/dL', 'Serum', '2.0', NULL),
('TP', 'Total Protein', 'Chemistry', 'Liver Function Panel', '6.0-8.3', 'g/dL', 'Serum', NULL, NULL),
('GGT', 'Gamma-Glutamyl Transferase', 'Chemistry', NULL, '9-48', 'U/L', 'Serum', NULL, NULL);

-- LIPID PROFILE
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('CHOL', 'Total Cholesterol', 'Chemistry', 'Lipid Panel', '<200', 'mg/dL', 'Serum', NULL, NULL),
('HDL', 'HDL Cholesterol', 'Chemistry', 'Lipid Panel', '>40 (M), >50 (F)', 'mg/dL', 'Serum', NULL, NULL),
('LDL', 'LDL Cholesterol', 'Chemistry', 'Lipid Panel', '<100', 'mg/dL', 'Serum', NULL, NULL),
('TRIG', 'Triglycerides', 'Chemistry', 'Lipid Panel', '<150', 'mg/dL', 'Serum', NULL, NULL),
('VLDL', 'VLDL Cholesterol', 'Chemistry', 'Lipid Panel', '5-40', 'mg/dL', 'Serum', NULL, NULL);

-- THYROID FUNCTION
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('TSH', 'Thyroid Stimulating Hormone', 'Endocrinology', 'Thyroid Panel', '0.4-4.0', 'mIU/L', 'Serum', NULL, NULL),
('T4', 'Thyroxine (Total T4)', 'Endocrinology', 'Thyroid Panel', '5-12', 'µg/dL', 'Serum', NULL, NULL),
('T3', 'Triiodothyronine (Total T3)', 'Endocrinology', 'Thyroid Panel', '80-200', 'ng/dL', 'Serum', NULL, NULL),
('FT4', 'Free T4', 'Endocrinology', 'Thyroid Panel', '0.8-1.8', 'ng/dL', 'Serum', NULL, NULL),
('FT3', 'Free T3', 'Endocrinology', 'Thyroid Panel', '2.3-4.2', 'pg/mL', 'Serum', NULL, NULL);

-- COAGULATION STUDIES
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('PT', 'Prothrombin Time', 'Hematology', 'Coagulation Panel', '11-13.5', 'seconds', 'Plasma (Citrate)', NULL, '20'),
('INR', 'International Normalized Ratio', 'Hematology', 'Coagulation Panel', '0.8-1.1', 'ratio', 'Plasma (Citrate)', NULL, '5.0'),
('PTT', 'Partial Thromboplastin Time', 'Hematology', 'Coagulation Panel', '25-35', 'seconds', 'Plasma (Citrate)', NULL, '100'),
('APTT', 'Activated Partial Thromboplastin Time', 'Hematology', 'Coagulation Panel', '25-35', 'seconds', 'Plasma (Citrate)', NULL, '100'),
('FІБR', 'Fibrinogen', 'Hematology', NULL, '200-400', 'mg/dL', 'Plasma (Citrate)', '100', NULL),
('DDIMER', 'D-Dimer', 'Hematology', NULL, '<0.5', 'µg/mL', 'Plasma (Citrate)', NULL, NULL);

-- CARDIAC MARKERS
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('TROP', 'Troponin I', 'Chemistry', 'Cardiac Panel', '<0.04', 'ng/mL', 'Serum', NULL, '0.04'),
('CKMB', 'Creatine Kinase-MB', 'Chemistry', 'Cardiac Panel', '<5', 'ng/mL', 'Serum', NULL, NULL),
('BNP', 'B-type Natriuretic Peptide', 'Chemistry', NULL, '<100', 'pg/mL', 'Plasma (EDTA)', NULL, '500'),
('CK', 'Creatine Kinase', 'Chemistry', NULL, '30-200', 'U/L', 'Serum', NULL, '1000'),
('LDH', 'Lactate Dehydrogenase', 'Chemistry', NULL, '122-222', 'U/L', 'Serum', NULL, NULL);

-- URINALYSIS
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('UA', 'Urinalysis Complete', 'Urinalysis', NULL, 'See individual components', 'N/A', 'Urine', NULL, NULL),
('UAPН', 'Urine pH', 'Urinalysis', 'Urinalysis', '4.5-8.0', 'pH', 'Urine', NULL, NULL),
('UASG', 'Urine Specific Gravity', 'Urinalysis', 'Urinalysis', '1.005-1.030', 'ratio', 'Urine', NULL, NULL),
('UAPRO', 'Urine Protein', 'Urinalysis', 'Urinalysis', 'Negative', 'Qualitative', 'Urine', NULL, NULL),
('UAGLC', 'Urine Glucose', 'Urinalysis', 'Urinalysis', 'Negative', 'Qualitative', 'Urine', NULL, NULL),
('UAKET', 'Urine Ketones', 'Urinalysis', 'Urinalysis', 'Negative', 'Qualitative', 'Urine', NULL, NULL),
('UABLD', 'Urine Blood', 'Urinalysis', 'Urinalysis', 'Negative', 'Qualitative', 'Urine', NULL, NULL),
('UALEU', 'Urine Leukocyte Esterase', 'Urinalysis', 'Urinalysis', 'Negative', 'Qualitative', 'Urine', NULL, NULL),
('UANIT', 'Urine Nitrite', 'Urinalysis', 'Urinalysis', 'Negative', 'Qualitative', 'Urine', NULL, NULL);

-- INFECTIOUS DISEASE SEROLOGY
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('HBSAG', 'Hepatitis B Surface Antigen', 'Serology', NULL, 'Negative', 'Qualitative', 'Serum', NULL, NULL),
('HCV', 'Hepatitis C Antibody', 'Serology', NULL, 'Negative', 'Qualitative', 'Serum', NULL, NULL),
('HIV', 'HIV Antibody', 'Serology', NULL, 'Negative', 'Qualitative', 'Serum', NULL, NULL),
('VDRL', 'VDRL (Syphilis)', 'Serology', NULL, 'Non-reactive', 'Qualitative', 'Serum', NULL, NULL),
('WIDAL', 'Widal Test', 'Serology', NULL, 'Negative', 'Qualitative', 'Serum', NULL, NULL),
('CRP', 'C-Reactive Protein', 'Serology', NULL, '<10', 'mg/L', 'Serum', NULL, NULL),
('RF', 'Rheumatoid Factor', 'Serology', NULL, '<20', 'IU/mL', 'Serum', NULL, NULL);

-- DIABETES MARKERS
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('HBA1C', 'Hemoglobin A1c', 'Chemistry', NULL, '4.0-5.6', '%', 'Whole Blood (EDTA)', NULL, NULL),
('FBS', 'Fasting Blood Sugar', 'Chemistry', NULL, '70-100', 'mg/dL', 'Serum/Plasma', '40', '500'),
('RBS', 'Random Blood Sugar', 'Chemistry', NULL, '70-140', 'mg/dL', 'Serum/Plasma', '40', '500'),
('OGTT', 'Oral Glucose Tolerance Test', 'Chemistry', NULL, '<140 at 2hr', 'mg/dL', 'Serum/Plasma', NULL, NULL);

-- HORMONES
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('CORT', 'Cortisol (AM)', 'Endocrinology', NULL, '5-25', 'µg/dL', 'Serum', NULL, NULL),
('ACTH', 'Adrenocorticotropic Hormone', 'Endocrinology', NULL, '10-60', 'pg/mL', 'Plasma (EDTA)', NULL, NULL),
('TESTO', 'Testosterone (Total)', 'Endocrinology', NULL, '300-1000 (M), 15-70 (F)', 'ng/dL', 'Serum', NULL, NULL),
('PROG', 'Progesterone', 'Endocrinology', NULL, 'Varies by phase', 'ng/mL', 'Serum', NULL, NULL),
('PROL', 'Prolactin', 'Endocrinology', NULL, '2-18 (M), 2-29 (F)', 'ng/mL', 'Serum', NULL, NULL);

-- VITAMINS & MINERALS
INSERT INTO public.lab_test_master (test_code, test_name, category, panel_name, reference_range_general, unit_of_measure, sample_type, critical_low, critical_high) VALUES
('VITD', 'Vitamin D (25-OH)', 'Chemistry', NULL, '30-100', 'ng/mL', 'Serum', NULL, NULL),
('VITB12', 'Vitamin B12', 'Chemistry', NULL, '200-900', 'pg/mL', 'Serum', NULL, NULL),
('FOLATE', 'Folate (Folic Acid)', 'Chemistry', NULL, '2.7-17.0', 'ng/mL', 'Serum', NULL, NULL),
('FE', 'Iron', 'Chemistry', NULL, '60-170', 'µg/dL', 'Serum', NULL, NULL),
('TIBC', 'Total Iron Binding Capacity', 'Chemistry', NULL, '240-450', 'µg/dL', 'Serum', NULL, NULL),
('FERR', 'Ferritin', 'Chemistry', NULL, '12-300 (M), 12-150 (F)', 'ng/mL', 'Serum', NULL, NULL);

-- Add trigger for updated_at
CREATE TRIGGER update_lab_test_master_updated_at
  BEFORE UPDATE ON public.lab_test_master
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.lab_test_master IS 'Master table containing standardized laboratory test information with reference ranges, units, and sample types based on clinical laboratory standards';