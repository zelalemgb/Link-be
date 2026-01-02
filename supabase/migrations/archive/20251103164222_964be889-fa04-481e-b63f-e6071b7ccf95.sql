-- Create medication master table based on ICD-11 Essential Medicines List
CREATE TABLE IF NOT EXISTS public.medication_master (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_name TEXT NOT NULL,
  generic_name TEXT,
  dosage_form TEXT NOT NULL, -- tablet, capsule, syrup, injection, etc.
  strength TEXT, -- e.g., "500mg", "10mg/ml"
  route TEXT NOT NULL DEFAULT 'oral', -- oral, IV, IM, topical, etc.
  category TEXT NOT NULL, -- antibiotics, analgesics, antihypertensive, etc.
  icd11_code TEXT, -- ICD-11 reference code if available
  standard_dosage TEXT, -- Common dosing guideline
  frequency_options TEXT[], -- Common frequencies: ["Once daily", "Twice daily", "Three times daily", "Four times daily", "As needed"]
  duration_options TEXT[], -- Common durations: ["3 days", "5 days", "7 days", "14 days", "30 days", "Ongoing"]
  contraindications TEXT,
  side_effects TEXT,
  pregnancy_category TEXT, -- A, B, C, D, X
  is_controlled BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create index for faster searches
CREATE INDEX IF NOT EXISTS idx_medication_master_name ON public.medication_master(medication_name);
CREATE INDEX IF NOT EXISTS idx_medication_master_generic ON public.medication_master(generic_name);
CREATE INDEX IF NOT EXISTS idx_medication_master_category ON public.medication_master(category);

-- Enable RLS
ALTER TABLE public.medication_master ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to view medications
CREATE POLICY "All authenticated users can view medications"
ON public.medication_master
FOR SELECT
TO authenticated
USING (is_active = true);

-- Allow medical staff and super admins to manage medications
CREATE POLICY "Medical staff and admins can manage medications"
ON public.medication_master
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
    AND user_role IN ('super_admin', 'doctor', 'clinical_officer', 'pharmacist')
  )
);

-- Insert common essential medications from WHO Essential Medicines List (ICD-11 based)
INSERT INTO public.medication_master (medication_name, generic_name, dosage_form, strength, route, category, standard_dosage, frequency_options, duration_options, contraindications) VALUES
-- Analgesics
('Paracetamol', 'Acetaminophen', 'Tablet', '500mg', 'oral', 'Analgesics/Antipyretics', '500-1000mg', ARRAY['Every 4-6 hours', 'Every 6-8 hours', 'As needed'], ARRAY['3 days', '5 days', '7 days', 'As needed'], 'Severe liver disease'),
('Ibuprofen', 'Ibuprofen', 'Tablet', '400mg', 'oral', 'NSAIDs', '400-800mg', ARRAY['Every 6-8 hours', 'Three times daily', 'As needed'], ARRAY['3 days', '5 days', '7 days'], 'Active peptic ulcer, severe heart failure'),
('Diclofenac', 'Diclofenac', 'Tablet', '50mg', 'oral', 'NSAIDs', '50mg', ARRAY['Twice daily', 'Three times daily'], ARRAY['5 days', '7 days', '14 days'], 'Peptic ulcer, severe renal impairment'),
('Tramadol', 'Tramadol', 'Tablet', '50mg', 'oral', 'Opioid Analgesics', '50-100mg', ARRAY['Every 4-6 hours', 'Every 6-8 hours', 'As needed'], ARRAY['3 days', '5 days', '7 days'], 'Respiratory depression, concurrent MAOI use'),

-- Antibiotics
('Amoxicillin', 'Amoxicillin', 'Capsule', '500mg', 'oral', 'Antibiotics - Penicillins', '500mg', ARRAY['Three times daily', 'Twice daily'], ARRAY['5 days', '7 days', '10 days'], 'Penicillin allergy'),
('Amoxicillin-Clavulanate', 'Amoxicillin-Clavulanic Acid', 'Tablet', '625mg', 'oral', 'Antibiotics - Penicillins', '625mg', ARRAY['Twice daily', 'Three times daily'], ARRAY['5 days', '7 days'], 'Penicillin allergy, history of jaundice with this drug'),
('Azithromycin', 'Azithromycin', 'Tablet', '500mg', 'oral', 'Antibiotics - Macrolides', '500mg once daily', ARRAY['Once daily'], ARRAY['3 days', '5 days'], 'Macrolide allergy'),
('Ciprofloxacin', 'Ciprofloxacin', 'Tablet', '500mg', 'oral', 'Antibiotics - Fluoroquinolones', '500mg', ARRAY['Twice daily'], ARRAY['5 days', '7 days', '10 days', '14 days'], 'Quinolone allergy, children < 18 years'),
('Metronidazole', 'Metronidazole', 'Tablet', '400mg', 'oral', 'Antibiotics - Antiprotozoal', '400mg', ARRAY['Three times daily', 'Twice daily'], ARRAY['5 days', '7 days', '10 days'], 'Alcohol consumption, first trimester pregnancy'),
('Ceftriaxone', 'Ceftriaxone', 'Injection', '1g', 'IV/IM', 'Antibiotics - Cephalosporins', '1-2g', ARRAY['Once daily', 'Twice daily'], ARRAY['5 days', '7 days', '10 days'], 'Cephalosporin allergy'),
('Doxycycline', 'Doxycycline', 'Capsule', '100mg', 'oral', 'Antibiotics - Tetracyclines', '100mg', ARRAY['Twice daily', 'Once daily'], ARRAY['7 days', '14 days', '21 days'], 'Pregnancy, children < 8 years'),

-- Antimalarials
('Artemether-Lumefantrine', 'Artemether-Lumefantrine', 'Tablet', '80mg/480mg', 'oral', 'Antimalarials', '4 tablets', ARRAY['Twice daily'], ARRAY['3 days'], 'First trimester pregnancy, severe malaria'),
('Quinine', 'Quinine Sulfate', 'Tablet', '300mg', 'oral', 'Antimalarials', '600mg', ARRAY['Three times daily'], ARRAY['7 days'], 'G6PD deficiency, optic neuritis'),

-- Antihypertensives
('Amlodipine', 'Amlodipine', 'Tablet', '5mg', 'oral', 'Antihypertensives - CCB', '5-10mg', ARRAY['Once daily'], ARRAY['30 days', '90 days', 'Ongoing'], 'Severe aortic stenosis'),
('Enalapril', 'Enalapril', 'Tablet', '5mg', 'oral', 'Antihypertensives - ACE Inhibitors', '5-20mg', ARRAY['Once daily', 'Twice daily'], ARRAY['30 days', '90 days', 'Ongoing'], 'Pregnancy, bilateral renal artery stenosis'),
('Hydrochlorothiazide', 'Hydrochlorothiazide', 'Tablet', '25mg', 'oral', 'Diuretics', '12.5-25mg', ARRAY['Once daily'], ARRAY['30 days', '90 days', 'Ongoing'], 'Anuria, severe renal impairment'),
('Nifedipine', 'Nifedipine SR', 'Tablet', '20mg', 'oral', 'Antihypertensives - CCB', '20mg', ARRAY['Twice daily'], ARRAY['30 days', '90 days', 'Ongoing'], 'Acute MI, unstable angina'),

-- Antidiabetics
('Metformin', 'Metformin', 'Tablet', '500mg', 'oral', 'Antidiabetics', '500-1000mg', ARRAY['Twice daily', 'Three times daily'], ARRAY['30 days', '90 days', 'Ongoing'], 'Severe renal impairment, metabolic acidosis'),
('Glibenclamide', 'Glibenclamide', 'Tablet', '5mg', 'oral', 'Antidiabetics - Sulfonylureas', '2.5-5mg', ARRAY['Once daily', 'Twice daily'], ARRAY['30 days', '90 days', 'Ongoing'], 'Type 1 diabetes, severe hepatic disease'),
('Insulin', 'Human Insulin', 'Injection', '100IU/ml', 'SC', 'Antidiabetics - Insulin', 'Variable', ARRAY['As prescribed'], ARRAY['Ongoing'], 'Hypoglycemia'),

-- Antiulcer/GI
('Omeprazole', 'Omeprazole', 'Capsule', '20mg', 'oral', 'Proton Pump Inhibitors', '20-40mg', ARRAY['Once daily', 'Twice daily'], ARRAY['14 days', '30 days', '90 days'], 'Severe liver disease'),
('Ranitidine', 'Ranitidine', 'Tablet', '150mg', 'oral', 'H2 Receptor Antagonists', '150mg', ARRAY['Twice daily', 'Once daily at night'], ARRAY['14 days', '30 days'], 'Severe renal impairment'),
('Hyoscine Butylbromide', 'Buscopan', 'Tablet', '10mg', 'oral', 'Antispasmodics', '10-20mg', ARRAY['Three times daily', 'Four times daily', 'As needed'], ARRAY['3 days', '5 days', '7 days'], 'Glaucoma, myasthenia gravis'),

-- Antiemetics
('Metoclopramide', 'Metoclopramide', 'Tablet', '10mg', 'oral', 'Antiemetics', '10mg', ARRAY['Three times daily', 'As needed'], ARRAY['3 days', '5 days'], 'GI obstruction, pheochromocytoma'),
('Ondansetron', 'Ondansetron', 'Tablet', '4mg', 'oral', 'Antiemetics', '4-8mg', ARRAY['Twice daily', 'Three times daily'], ARRAY['3 days', '5 days'], 'Congenital long QT syndrome'),

-- Respiratory
('Salbutamol', 'Salbutamol', 'Inhaler', '100mcg', 'Inhalation', 'Bronchodilators', '2 puffs', ARRAY['Four times daily', 'As needed'], ARRAY['30 days', 'Ongoing'], 'Tachycardia'),
('Prednisolone', 'Prednisolone', 'Tablet', '5mg', 'oral', 'Corticosteroids', '5-60mg', ARRAY['Once daily', 'Twice daily'], ARRAY['5 days', '7 days', '14 days', '30 days'], 'Active systemic fungal infection'),

-- Antihistamines
('Cetirizine', 'Cetirizine', 'Tablet', '10mg', 'oral', 'Antihistamines', '10mg', ARRAY['Once daily', 'As needed'], ARRAY['7 days', '14 days', '30 days'], 'Severe renal impairment'),
('Chlorpheniramine', 'Chlorpheniramine', 'Tablet', '4mg', 'oral', 'Antihistamines', '4mg', ARRAY['Three times daily', 'Four times daily'], ARRAY['5 days', '7 days'], 'Narrow-angle glaucoma'),

-- Vitamins/Supplements
('Folic Acid', 'Folic Acid', 'Tablet', '5mg', 'oral', 'Vitamins', '5mg', ARRAY['Once daily'], ARRAY['30 days', '90 days', 'Ongoing'], 'Vitamin B12 deficiency anemia'),
('Iron Sulfate', 'Ferrous Sulfate', 'Tablet', '200mg', 'oral', 'Minerals', '200mg', ARRAY['Once daily', 'Twice daily'], ARRAY['30 days', '90 days'], 'Hemochromatosis'),
('Vitamin B Complex', 'B-Complex', 'Tablet', 'Standard', 'oral', 'Vitamins', '1 tablet', ARRAY['Once daily'], ARRAY['30 days', '90 days'], 'None significant'),
('Multivitamin', 'Multivitamin', 'Tablet', 'Standard', 'oral', 'Vitamins', '1 tablet', ARRAY['Once daily'], ARRAY['30 days', '90 days'], 'Hypervitaminosis')
ON CONFLICT DO NOTHING;

-- Add trigger for updated_at
CREATE TRIGGER update_medication_master_updated_at
BEFORE UPDATE ON public.medication_master
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();