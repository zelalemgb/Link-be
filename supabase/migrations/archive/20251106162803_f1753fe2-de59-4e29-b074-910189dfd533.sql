-- Phase 3: Visit Narrative System

-- Step 1: Create triage table
CREATE TABLE IF NOT EXISTS public.triage (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE UNIQUE,
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  triaged_by UUID NOT NULL REFERENCES public.users(id),
  triaged_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  triage_category TEXT NOT NULL CHECK (triage_category IN ('RED', 'YELLOW', 'GREEN', 'WHITE', 'BLACK')),
  arrival_mode TEXT CHECK (arrival_mode IN ('walk_in', 'ambulance', 'referral', 'police', 'other')),
  
  -- Vital signs
  temperature NUMERIC,
  temperature_unit TEXT DEFAULT 'celsius' CHECK (temperature_unit IN ('celsius', 'fahrenheit')),
  pulse_rate INTEGER,
  respiratory_rate INTEGER,
  blood_pressure_systolic INTEGER,
  blood_pressure_diastolic INTEGER,
  oxygen_saturation INTEGER,
  weight NUMERIC,
  weight_unit TEXT DEFAULT 'kg' CHECK (weight_unit IN ('kg', 'lbs')),
  height NUMERIC,
  height_unit TEXT DEFAULT 'cm' CHECK (height_unit IN ('cm', 'inches')),
  bmi NUMERIC,
  
  -- Triage assessment
  chief_complaint TEXT,
  pain_score INTEGER CHECK (pain_score BETWEEN 0 AND 10),
  consciousness_level TEXT CHECK (consciousness_level IN ('alert', 'verbal', 'pain', 'unresponsive', 'AVPU_A', 'AVPU_V', 'AVPU_P', 'AVPU_U')),
  glasgow_coma_score INTEGER CHECK (glasgow_coma_score BETWEEN 3 AND 15),
  
  -- Clinical flags
  is_pregnant BOOLEAN,
  gestational_age_weeks INTEGER,
  allergies TEXT,
  current_medications TEXT,
  isolation_required BOOLEAN DEFAULT false,
  isolation_type TEXT,
  
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for triage
CREATE INDEX IF NOT EXISTS idx_triage_tenant_id ON public.triage(tenant_id);
CREATE INDEX IF NOT EXISTS idx_triage_visit_id ON public.triage(visit_id);
CREATE INDEX IF NOT EXISTS idx_triage_facility_id ON public.triage(facility_id);
CREATE INDEX IF NOT EXISTS idx_triage_category ON public.triage(triage_category);
CREATE INDEX IF NOT EXISTS idx_triage_triaged_at ON public.triage(triaged_at DESC);

-- Enable RLS on triage
ALTER TABLE public.triage ENABLE ROW LEVEL SECURITY;

-- Step 2: Create visit_narratives table for multilingual documentation
CREATE TABLE IF NOT EXISTS public.visit_narratives (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  authored_by UUID NOT NULL REFERENCES public.users(id),
  authored_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  narrative_type TEXT NOT NULL CHECK (narrative_type IN ('chief_complaint', 'hpi', 'ros', 'physical_exam', 'assessment', 'plan', 'progress_note', 'discharge_summary')),
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'am', 'om', 'ti', 'so')), -- English, Amharic, Afaan Oromo, Tigrinya, Somali
  narrative_text TEXT NOT NULL,
  
  -- AI extraction metadata
  extracted_at TIMESTAMP WITH TIME ZONE,
  extraction_confidence NUMERIC CHECK (extraction_confidence BETWEEN 0 AND 1),
  extraction_model TEXT,
  
  is_signed BOOLEAN DEFAULT false,
  signed_by UUID REFERENCES public.users(id),
  signed_at TIMESTAMP WITH TIME ZONE,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for visit_narratives
CREATE INDEX IF NOT EXISTS idx_visit_narratives_tenant_id ON public.visit_narratives(tenant_id);
CREATE INDEX IF NOT EXISTS idx_visit_narratives_visit_id ON public.visit_narratives(visit_id);
CREATE INDEX IF NOT EXISTS idx_visit_narratives_type ON public.visit_narratives(narrative_type);
CREATE INDEX IF NOT EXISTS idx_visit_narratives_locale ON public.visit_narratives(locale);
CREATE INDEX IF NOT EXISTS idx_visit_narratives_authored_at ON public.visit_narratives(authored_at DESC);

-- Enable RLS on visit_narratives
ALTER TABLE public.visit_narratives ENABLE ROW LEVEL SECURITY;

-- Step 3: Create visit_tags table for structured extraction
CREATE TABLE IF NOT EXISTS public.visit_tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE UNIQUE,
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  
  -- Extracted structured data
  chief_complaint_structured TEXT,
  duration_days INTEGER,
  severity TEXT CHECK (severity IN ('mild', 'moderate', 'severe', 'critical')),
  onset TEXT CHECK (onset IN ('sudden', 'gradual', 'chronic')),
  
  -- Extracted codes
  icd11_codes TEXT[],
  snomed_codes TEXT[],
  
  -- Clinical impression
  working_diagnosis TEXT[],
  differential_diagnosis TEXT[],
  
  -- Completeness flags
  is_complete BOOLEAN DEFAULT false,
  completeness_score NUMERIC CHECK (completeness_score BETWEEN 0 AND 1),
  
  extracted_at TIMESTAMP WITH TIME ZONE,
  extraction_version TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for visit_tags
CREATE INDEX IF NOT EXISTS idx_visit_tags_tenant_id ON public.visit_tags(tenant_id);
CREATE INDEX IF NOT EXISTS idx_visit_tags_visit_id ON public.visit_tags(visit_id);
CREATE INDEX IF NOT EXISTS idx_visit_tags_is_complete ON public.visit_tags(is_complete);

-- Enable RLS on visit_tags
ALTER TABLE public.visit_tags ENABLE ROW LEVEL SECURITY;

-- Step 4: Create visit_associated_symptoms table
CREATE TABLE IF NOT EXISTS public.visit_associated_symptoms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  visit_tags_id UUID REFERENCES public.visit_tags(id) ON DELETE CASCADE,
  
  symptom_code TEXT,
  symptom_name TEXT NOT NULL,
  symptom_name_locale TEXT, -- Original language symptom was documented in
  severity TEXT CHECK (severity IN ('mild', 'moderate', 'severe')),
  duration_text TEXT,
  duration_hours INTEGER,
  
  -- Provenance
  source TEXT NOT NULL CHECK (source IN ('narrative_extraction', 'structured_input', 'inference')),
  confidence NUMERIC CHECK (confidence BETWEEN 0 AND 1),
  extracted_from_narrative_id UUID REFERENCES public.visit_narratives(id),
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for visit_associated_symptoms
CREATE INDEX IF NOT EXISTS idx_visit_associated_symptoms_tenant_id ON public.visit_associated_symptoms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_visit_associated_symptoms_visit_id ON public.visit_associated_symptoms(visit_id);
CREATE INDEX IF NOT EXISTS idx_visit_associated_symptoms_visit_tags_id ON public.visit_associated_symptoms(visit_tags_id);
CREATE INDEX IF NOT EXISTS idx_visit_associated_symptoms_symptom_code ON public.visit_associated_symptoms(symptom_code);

-- Enable RLS on visit_associated_symptoms
ALTER TABLE public.visit_associated_symptoms ENABLE ROW LEVEL SECURITY;

-- Step 5: Create visit_negative_symptoms table
CREATE TABLE IF NOT EXISTS public.visit_negative_symptoms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  visit_tags_id UUID REFERENCES public.visit_tags(id) ON DELETE CASCADE,
  
  symptom_code TEXT,
  symptom_name TEXT NOT NULL,
  symptom_category TEXT,
  
  -- Provenance
  source TEXT NOT NULL CHECK (source IN ('narrative_extraction', 'structured_input', 'clinical_review')),
  confidence NUMERIC CHECK (confidence BETWEEN 0 AND 1),
  extracted_from_narrative_id UUID REFERENCES public.visit_narratives(id),
  documented_by UUID REFERENCES public.users(id),
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for visit_negative_symptoms
CREATE INDEX IF NOT EXISTS idx_visit_negative_symptoms_tenant_id ON public.visit_negative_symptoms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_visit_negative_symptoms_visit_id ON public.visit_negative_symptoms(visit_id);
CREATE INDEX IF NOT EXISTS idx_visit_negative_symptoms_visit_tags_id ON public.visit_negative_symptoms(visit_tags_id);

-- Enable RLS on visit_negative_symptoms
ALTER TABLE public.visit_negative_symptoms ENABLE ROW LEVEL SECURITY;

-- Step 6: Create lexicon_terms table for NLP
CREATE TABLE IF NOT EXISTS public.lexicon_terms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  
  term TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'am', 'om', 'ti', 'so')),
  term_type TEXT NOT NULL CHECK (term_type IN ('symptom', 'diagnosis', 'medication', 'procedure', 'body_part', 'modifier', 'negation', 'temporal')),
  
  -- Normalization
  canonical_term TEXT NOT NULL,
  canonical_code TEXT, -- SNOMED, ICD-11, etc.
  coding_system TEXT CHECK (coding_system IN ('snomed', 'icd11', 'loinc', 'rxnorm', 'custom')),
  
  -- Synonyms and variations
  synonyms TEXT[],
  abbreviations TEXT[],
  
  -- Context
  context_category TEXT,
  is_active BOOLEAN DEFAULT true,
  
  -- Usage tracking
  usage_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMP WITH TIME ZONE,
  
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  UNIQUE (tenant_id, term, locale, term_type)
);

-- Create indexes for lexicon_terms
CREATE INDEX IF NOT EXISTS idx_lexicon_terms_tenant_id ON public.lexicon_terms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lexicon_terms_term ON public.lexicon_terms(term);
CREATE INDEX IF NOT EXISTS idx_lexicon_terms_locale ON public.lexicon_terms(locale);
CREATE INDEX IF NOT EXISTS idx_lexicon_terms_type ON public.lexicon_terms(term_type);
CREATE INDEX IF NOT EXISTS idx_lexicon_terms_canonical ON public.lexicon_terms(canonical_term);
CREATE INDEX IF NOT EXISTS idx_lexicon_terms_code ON public.lexicon_terms(canonical_code);

-- Enable RLS on lexicon_terms
ALTER TABLE public.lexicon_terms ENABLE ROW LEVEL SECURITY;

-- Step 7: Migrate existing triage data from visits (if any triage columns exist in visits)
-- Note: The current visits table doesn't have explicit triage columns, so this creates empty records
-- for existing visits that we can populate later

-- Step 8: Create RLS policies for triage
CREATE POLICY "Facility staff can view triage" ON public.triage
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Nurses can create triage" ON public.triage
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('nurse', 'doctor', 'clinical_officer')
    )
  );

CREATE POLICY "Nurses can update triage" ON public.triage
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('nurse', 'doctor', 'clinical_officer')
    )
  );

CREATE POLICY "Super admins can manage all triage" ON public.triage
  FOR ALL USING (is_super_admin());

-- Step 9: Create RLS policies for visit_narratives
CREATE POLICY "Facility staff can view narratives" ON public.visit_narratives
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT id
      FROM public.visits
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
  );

CREATE POLICY "Clinical staff can create narratives" ON public.visit_narratives
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT id
      FROM public.visits
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('doctor', 'clinical_officer', 'nurse')
    )
  );

CREATE POLICY "Authors can update their own narratives" ON public.visit_narratives
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT id
      FROM public.visits
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
    AND authored_by IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "Super admins can manage all narratives" ON public.visit_narratives
  FOR ALL USING (is_super_admin());

-- Step 10: Create RLS policies for visit_tags
CREATE POLICY "Facility staff can view visit tags" ON public.visit_tags
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT id
      FROM public.visits
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
  );

CREATE POLICY "System can manage visit tags" ON public.visit_tags
  FOR ALL USING (
    (
      tenant_id = get_user_tenant_id()
      AND visit_id IN (
        SELECT id
        FROM public.visits
        WHERE tenant_id = get_user_tenant_id()
          AND facility_id = get_user_facility_id()
      )
    )
    OR is_super_admin()
  )
  WITH CHECK (
    (
      tenant_id = get_user_tenant_id()
      AND visit_id IN (
        SELECT id
        FROM public.visits
        WHERE tenant_id = get_user_tenant_id()
          AND facility_id = get_user_facility_id()
      )
    )
    OR is_super_admin()
  );

-- Step 11: Create RLS policies for visit_associated_symptoms
CREATE POLICY "Facility staff can view associated symptoms" ON public.visit_associated_symptoms
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT id
      FROM public.visits
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
  );

CREATE POLICY "System can manage associated symptoms" ON public.visit_associated_symptoms
  FOR ALL USING (
    (
      tenant_id = get_user_tenant_id()
      AND visit_id IN (
        SELECT id
        FROM public.visits
        WHERE tenant_id = get_user_tenant_id()
          AND facility_id = get_user_facility_id()
      )
    )
    OR is_super_admin()
  )
  WITH CHECK (
    (
      tenant_id = get_user_tenant_id()
      AND visit_id IN (
        SELECT id
        FROM public.visits
        WHERE tenant_id = get_user_tenant_id()
          AND facility_id = get_user_facility_id()
      )
    )
    OR is_super_admin()
  );

-- Step 12: Create RLS policies for visit_negative_symptoms
CREATE POLICY "Facility staff can view negative symptoms" ON public.visit_negative_symptoms
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT id
      FROM public.visits
      WHERE tenant_id = get_user_tenant_id()
        AND facility_id = get_user_facility_id()
    )
  );

CREATE POLICY "System can manage negative symptoms" ON public.visit_negative_symptoms
  FOR ALL USING (
    (
      tenant_id = get_user_tenant_id()
      AND visit_id IN (
        SELECT id
        FROM public.visits
        WHERE tenant_id = get_user_tenant_id()
          AND facility_id = get_user_facility_id()
      )
    )
    OR is_super_admin()
  )
  WITH CHECK (
    (
      tenant_id = get_user_tenant_id()
      AND visit_id IN (
        SELECT id
        FROM public.visits
        WHERE tenant_id = get_user_tenant_id()
          AND facility_id = get_user_facility_id()
      )
    )
    OR is_super_admin()
  );

-- Step 13: Create RLS policies for lexicon_terms
CREATE POLICY "Facility staff can view lexicon terms" ON public.lexicon_terms
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    OR is_super_admin()
  );

CREATE POLICY "Clinical staff can create lexicon terms" ON public.lexicon_terms
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'medical_director', 'super_admin')
    )
  );

CREATE POLICY "Clinical staff can update lexicon terms" ON public.lexicon_terms
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'medical_director', 'super_admin')
    )
  );

CREATE POLICY "Super admins can manage all lexicon terms" ON public.lexicon_terms
  FOR ALL USING (is_super_admin());

-- Step 14: Create triggers for updated_at
CREATE TRIGGER update_triage_updated_at
  BEFORE UPDATE ON public.triage
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_visit_narratives_updated_at
  BEFORE UPDATE ON public.visit_narratives
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_visit_tags_updated_at
  BEFORE UPDATE ON public.visit_tags
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_visit_associated_symptoms_updated_at
  BEFORE UPDATE ON public.visit_associated_symptoms
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_lexicon_terms_updated_at
  BEFORE UPDATE ON public.lexicon_terms
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Step 15: Add comments for documentation
COMMENT ON TABLE public.triage IS 'Separate triage assessment table - captures initial patient assessment and vital signs';
COMMENT ON TABLE public.visit_narratives IS 'Multilingual clinical narratives - supports English, Amharic, Afaan Oromo, Tigrinya, Somali';
COMMENT ON TABLE public.visit_tags IS 'Structured data extracted from narratives using AI/NLP - one per visit summary';
COMMENT ON TABLE public.visit_associated_symptoms IS 'Symptoms extracted from narratives or entered directly';
COMMENT ON TABLE public.visit_negative_symptoms IS 'Pertinent negatives documented during clinical review';
COMMENT ON TABLE public.lexicon_terms IS 'Multi-lingual medical terminology dictionary for NLP extraction and normalization';