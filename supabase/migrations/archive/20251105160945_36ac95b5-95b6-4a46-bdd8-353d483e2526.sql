-- Create surgical_assessments table for surgical department
CREATE TABLE public.surgical_assessments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES public.users(id),
  
  -- Patient presentation
  presenting_complaint TEXT,
  duration_of_symptoms TEXT,
  pain_score INTEGER CHECK (pain_score BETWEEN 0 AND 10),
  
  -- Surgical assessment
  provisional_diagnosis TEXT,
  surgical_indication TEXT,
  procedure_proposed TEXT,
  anesthesia_type TEXT,
  
  -- ABC Priority classification
  priority_category TEXT CHECK (priority_category IN ('A', 'B', 'C')),
  priority_justification TEXT,
  target_surgery_date DATE,
  
  -- Pre-operative assessment
  asa_classification TEXT CHECK (asa_classification IN ('I', 'II', 'III', 'IV', 'V')),
  comorbidities TEXT,
  previous_surgeries TEXT,
  allergies TEXT,
  current_medications TEXT,
  
  -- Clinical examination
  general_condition TEXT CHECK (general_condition IN ('good', 'fair', 'poor', 'critical')),
  vital_signs_stable BOOLEAN DEFAULT true,
  cardiovascular_exam TEXT,
  respiratory_exam TEXT,
  abdominal_exam TEXT,
  other_systems TEXT,
  
  -- Investigations
  lab_tests_ordered TEXT[] DEFAULT '{}',
  imaging_ordered TEXT[] DEFAULT '{}',
  
  -- DHIS2 Indicators
  emergency_surgery BOOLEAN DEFAULT false,
  elective_surgery BOOLEAN DEFAULT false,
  major_surgery BOOLEAN DEFAULT false,
  minor_surgery BOOLEAN DEFAULT false,
  surgery_type TEXT,
  
  -- Appointment for surgery
  appointment_requested BOOLEAN DEFAULT false,
  preferred_date DATE,
  consent_obtained BOOLEAN DEFAULT false,
  
  notes TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.surgical_assessments ENABLE ROW LEVEL SECURITY;

-- Create policies for surgical assessments
CREATE POLICY "Users can view surgical assessments from their facility"
ON public.surgical_assessments
FOR SELECT
USING (
  facility_id IN (
    SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid()
  )
);

CREATE POLICY "Medical staff can create surgical assessments"
ON public.surgical_assessments
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
    AND user_role IN ('doctor', 'clinical_officer', 'nurse')
    AND facility_id = surgical_assessments.facility_id
  )
);

CREATE POLICY "Medical staff can update surgical assessments"
ON public.surgical_assessments
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
    AND user_role IN ('doctor', 'clinical_officer', 'nurse')
    AND facility_id = surgical_assessments.facility_id
  )
);

CREATE POLICY "Medical staff can delete surgical assessments"
ON public.surgical_assessments
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
    AND user_role IN ('doctor', 'clinical_officer', 'nurse', 'hospital_ceo', 'medical_director')
    AND facility_id = surgical_assessments.facility_id
  )
);

-- Create index for performance
CREATE INDEX idx_surgical_assessments_visit_id ON public.surgical_assessments(visit_id);
CREATE INDEX idx_surgical_assessments_patient_id ON public.surgical_assessments(patient_id);
CREATE INDEX idx_surgical_assessments_facility_id ON public.surgical_assessments(facility_id);
CREATE INDEX idx_surgical_assessments_priority_category ON public.surgical_assessments(priority_category);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_surgical_assessments_updated_at
BEFORE UPDATE ON public.surgical_assessments
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Add comment to table
COMMENT ON TABLE public.surgical_assessments IS 'Surgical assessments with ABC priority categorization for surgery scheduling';
