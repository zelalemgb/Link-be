-- Create ANC Assessments table
CREATE TABLE IF NOT EXISTS public.anc_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Visit Information
  anc_visit_number INTEGER NOT NULL,
  gestational_age_weeks INTEGER,
  expected_delivery_date DATE,
  
  -- Maternal Demographics
  gravida INTEGER,
  parity INTEGER,
  previous_pregnancies_outcome TEXT,
  
  -- Clinical Measurements
  weight NUMERIC,
  height NUMERIC,
  bmi NUMERIC,
  muac NUMERIC,
  fundal_height NUMERIC,
  fetal_heart_rate INTEGER,
  fetal_presentation TEXT,
  
  -- Laboratory Tests
  blood_group TEXT,
  rh_factor TEXT,
  hemoglobin NUMERIC,
  hiv_test_status TEXT,
  hiv_test_date DATE,
  syphilis_test_result TEXT,
  urine_protein TEXT,
  urine_glucose TEXT,
  malaria_test_result TEXT,
  
  -- Preventive Interventions
  tt_vaccination_status TEXT,
  iron_folic_acid_given BOOLEAN DEFAULT false,
  iptp_given BOOLEAN DEFAULT false,
  deworming_given BOOLEAN DEFAULT false,
  bed_net_distributed BOOLEAN DEFAULT false,
  
  -- Risk Factors
  previous_cesarean BOOLEAN DEFAULT false,
  chronic_conditions TEXT[],
  multiple_pregnancy BOOLEAN DEFAULT false,
  
  -- Counseling
  counseling_provided TEXT[],
  
  notes TEXT
);

-- Create Delivery Records table
CREATE TABLE IF NOT EXISTS public.delivery_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Admission Data
  admission_datetime TIMESTAMP WITH TIME ZONE NOT NULL,
  referral_status TEXT,
  labor_onset TEXT,
  
  -- Labor Monitoring
  partograph_used BOOLEAN DEFAULT false,
  labor_duration_hours NUMERIC,
  membrane_rupture_time TIMESTAMP WITH TIME ZONE,
  contractions_frequency INTEGER,
  
  -- Delivery Information
  delivery_datetime TIMESTAMP WITH TIME ZONE NOT NULL,
  mode_of_delivery TEXT NOT NULL,
  birth_attendant TEXT,
  delivery_complications TEXT[],
  episiotomy BOOLEAN DEFAULT false,
  
  -- Newborn Assessment
  birth_outcome TEXT NOT NULL,
  birth_weight NUMERIC,
  apgar_score_1min INTEGER,
  apgar_score_5min INTEGER,
  baby_sex TEXT,
  multiple_births BOOLEAN DEFAULT false,
  congenital_abnormalities TEXT,
  breastfeeding_initiated_1hour BOOLEAN DEFAULT false,
  vitamin_k_given BOOLEAN DEFAULT false,
  eye_prophylaxis_given BOOLEAN DEFAULT false,
  
  -- Maternal Outcome
  blood_loss_ml INTEGER,
  maternal_death BOOLEAN DEFAULT false,
  maternal_death_cause TEXT,
  pcv_post_delivery NUMERIC,
  hemoglobin_post_delivery NUMERIC,
  referral_out BOOLEAN DEFAULT false,
  referral_reason TEXT,
  
  notes TEXT
);

-- Create Emergency Assessments table
CREATE TABLE IF NOT EXISTS public.emergency_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Triage Category
  triage_category TEXT NOT NULL,
  
  -- Arrival Information
  arrival_datetime TIMESTAMP WITH TIME ZONE NOT NULL,
  arrival_mode TEXT,
  referral_source TEXT,
  
  -- Chief Complaint
  chief_complaint TEXT NOT NULL,
  
  -- Emergency Signs (ETAT)
  airway_obstruction BOOLEAN DEFAULT false,
  breathing_difficulty BOOLEAN DEFAULT false,
  circulatory_compromise BOOLEAN DEFAULT false,
  coma_convulsions BOOLEAN DEFAULT false,
  dehydration_status TEXT,
  
  -- AVPU/GCS
  avpu_score TEXT,
  gcs_score INTEGER,
  
  -- Interventions
  oxygen_therapy BOOLEAN DEFAULT false,
  iv_fluids_given BOOLEAN DEFAULT false,
  emergency_medications TEXT[],
  procedures_performed TEXT[],
  
  -- Disposition
  time_to_physician_evaluation INTEGER,
  disposition TEXT NOT NULL,
  admission_ward TEXT,
  final_diagnosis TEXT,
  treatment_provided TEXT,
  ed_length_of_stay_hours NUMERIC,
  
  notes TEXT
);

-- Create Immunization Records table
CREATE TABLE IF NOT EXISTS public.immunization_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Child Information
  birth_weight NUMERIC,
  place_of_birth TEXT,
  birth_registration_number TEXT,
  
  -- BCG Vaccination
  bcg_date DATE,
  bcg_batch_number TEXT,
  bcg_site TEXT,
  
  -- Polio Vaccination
  opv0_date DATE,
  opv0_batch TEXT,
  opv1_date DATE,
  opv1_batch TEXT,
  opv2_date DATE,
  opv2_batch TEXT,
  opv3_date DATE,
  opv3_batch TEXT,
  ipv_date DATE,
  ipv_batch TEXT,
  
  -- Pentavalent (DPT-HepB-Hib)
  penta1_date DATE,
  penta1_batch TEXT,
  penta2_date DATE,
  penta2_batch TEXT,
  penta3_date DATE,
  penta3_batch TEXT,
  
  -- PCV (Pneumococcal)
  pcv1_date DATE,
  pcv1_batch TEXT,
  pcv2_date DATE,
  pcv2_batch TEXT,
  pcv3_date DATE,
  pcv3_batch TEXT,
  
  -- Rotavirus
  rota1_date DATE,
  rota1_batch TEXT,
  rota2_date DATE,
  rota2_batch TEXT,
  
  -- Measles
  mcv1_date DATE,
  mcv1_batch TEXT,
  mcv2_date DATE,
  mcv2_batch TEXT,
  
  -- Vitamin A
  vitamin_a_6months DATE,
  vitamin_a_12months DATE,
  vitamin_a_18months DATE,
  vitamin_a_24months DATE,
  
  -- Status
  fully_immunized BOOLEAN DEFAULT false,
  defaulter_tracking BOOLEAN DEFAULT false,
  
  -- Adverse Events
  aefi_occurred BOOLEAN DEFAULT false,
  aefi_type TEXT,
  aefi_severity TEXT,
  aefi_outcome TEXT,
  
  -- Contraindications
  vaccine_not_given_reason TEXT,
  
  notes TEXT
);

-- Create Family Planning Visits table
CREATE TABLE IF NOT EXISTS public.family_planning_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Client Information
  client_type TEXT NOT NULL,
  parity INTEGER,
  number_of_living_children INTEGER,
  
  -- Reproductive History
  lmp DATE,
  previous_contraceptive_use TEXT,
  breastfeeding_status BOOLEAN,
  
  -- Method Selected
  contraceptive_method TEXT NOT NULL,
  method_category TEXT,
  
  -- Method Details
  method_start_date DATE NOT NULL,
  batch_number TEXT,
  expiry_date DATE,
  provider_name TEXT,
  
  -- Screening
  pregnancy_test_result TEXT,
  medical_eligibility TEXT,
  sti_screening_result TEXT,
  
  -- Counseling
  side_effects_discussed BOOLEAN DEFAULT false,
  dual_protection_discussed BOOLEAN DEFAULT false,
  return_visit_date DATE,
  
  -- Follow-up
  complications_side_effects TEXT,
  method_discontinued BOOLEAN DEFAULT false,
  discontinuation_reason TEXT,
  
  notes TEXT
);

-- Create Pediatric Assessments table
CREATE TABLE IF NOT EXISTS public.pediatric_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Admission Diagnosis
  primary_diagnosis TEXT,
  secondary_diagnosis TEXT,
  icd10_code TEXT,
  
  -- Nutritional Status
  weight_for_age_zscore NUMERIC,
  height_for_age_zscore NUMERIC,
  weight_for_height_zscore NUMERIC,
  muac NUMERIC,
  edema_grading TEXT,
  malnutrition_classification TEXT,
  
  -- Feeding Assessment
  breastfeeding_status TEXT,
  appetite_status TEXT,
  
  -- Developmental Milestones
  milestones_appropriate BOOLEAN,
  milestone_delays TEXT,
  
  -- Immunization Status
  immunization_up_to_date BOOLEAN,
  
  -- Common Pediatric Conditions
  pneumonia_classification TEXT,
  diarrhea_type TEXT,
  dehydration_status TEXT,
  malaria_positive BOOLEAN,
  
  -- Treatment
  therapeutic_feeding TEXT,
  antibiotics_given TEXT,
  zinc_supplementation BOOLEAN DEFAULT false,
  ors_given BOOLEAN DEFAULT false,
  
  notes TEXT
);

-- Enable RLS on all tables
ALTER TABLE public.anc_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.immunization_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_planning_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pediatric_assessments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for ANC Assessments
CREATE POLICY "Facility staff can view ANC assessments"
  ON public.anc_assessments FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Nurses and doctors can create ANC assessments"
  ON public.anc_assessments FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = ANY(ARRAY['nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
    )
  );

CREATE POLICY "Nurses and doctors can update ANC assessments"
  ON public.anc_assessments FOR UPDATE
  USING (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = ANY(ARRAY['nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
    )
  );

-- RLS Policies for Delivery Records
CREATE POLICY "Facility staff can view delivery records"
  ON public.delivery_records FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Nurses and doctors can create delivery records"
  ON public.delivery_records FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = ANY(ARRAY['nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
    )
  );

CREATE POLICY "Nurses and doctors can update delivery records"
  ON public.delivery_records FOR UPDATE
  USING (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = ANY(ARRAY['nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
    )
  );

-- RLS Policies for Emergency Assessments
CREATE POLICY "Facility staff can view emergency assessments"
  ON public.emergency_assessments FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Medical staff can create emergency assessments"
  ON public.emergency_assessments FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = ANY(ARRAY['nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
    )
  );

CREATE POLICY "Medical staff can update emergency assessments"
  ON public.emergency_assessments FOR UPDATE
  USING (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = ANY(ARRAY['nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
    )
  );

-- RLS Policies for Immunization Records
CREATE POLICY "Facility staff can view immunization records"
  ON public.immunization_records FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Nurses can create immunization records"
  ON public.immunization_records FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = 'nurse'::user_role
    )
  );

CREATE POLICY "Nurses can update immunization records"
  ON public.immunization_records FOR UPDATE
  USING (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = 'nurse'::user_role
    )
  );

-- RLS Policies for Family Planning Visits
CREATE POLICY "Facility staff can view family planning visits"
  ON public.family_planning_visits FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Nurses can create family planning visits"
  ON public.family_planning_visits FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = 'nurse'::user_role
    )
  );

CREATE POLICY "Nurses can update family planning visits"
  ON public.family_planning_visits FOR UPDATE
  USING (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = 'nurse'::user_role
    )
  );

-- RLS Policies for Pediatric Assessments
CREATE POLICY "Facility staff can view pediatric assessments"
  ON public.pediatric_assessments FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Medical staff can create pediatric assessments"
  ON public.pediatric_assessments FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = ANY(ARRAY['nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
    )
  );

CREATE POLICY "Medical staff can update pediatric assessments"
  ON public.pediatric_assessments FOR UPDATE
  USING (
    facility_id = get_user_facility_id() 
    AND EXISTS (
      SELECT 1 FROM users 
      WHERE users.auth_user_id = auth.uid() 
      AND users.user_role = ANY(ARRAY['nurse'::user_role, 'doctor'::user_role, 'clinical_officer'::user_role])
    )
  );

-- Add update triggers for all tables
CREATE TRIGGER update_anc_assessments_updated_at
  BEFORE UPDATE ON public.anc_assessments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_delivery_records_updated_at
  BEFORE UPDATE ON public.delivery_records
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_emergency_assessments_updated_at
  BEFORE UPDATE ON public.emergency_assessments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_immunization_records_updated_at
  BEFORE UPDATE ON public.immunization_records
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_family_planning_visits_updated_at
  BEFORE UPDATE ON public.family_planning_visits
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_pediatric_assessments_updated_at
  BEFORE UPDATE ON public.pediatric_assessments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();