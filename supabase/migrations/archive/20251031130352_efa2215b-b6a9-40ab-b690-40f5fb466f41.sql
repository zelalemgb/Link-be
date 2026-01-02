-- Create enum types for patient portal
CREATE TYPE patient_document_type AS ENUM (
  'prescription',
  'lab_result', 
  'imaging',
  'visit_summary',
  'vaccination',
  'other'
);

CREATE TYPE appointment_status AS ENUM (
  'pending',
  'confirmed',
  'declined',
  'completed',
  'cancelled'
);

CREATE TYPE symptom_urgency AS ENUM (
  'emergency',
  'urgent',
  'routine',
  'self_care'
);

CREATE TYPE visit_summary_source AS ENUM (
  'link_clinic',
  'manual_upload'
);

-- Create patient_accounts table
CREATE TABLE public.patient_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  date_of_birth DATE,
  gender TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  profile_photo_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Add patient_account_id to patients table
ALTER TABLE public.patients 
ADD COLUMN patient_account_id UUID REFERENCES public.patient_accounts(id);

-- Create patient_documents table
CREATE TABLE public.patient_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_account_id UUID NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  document_type patient_document_type NOT NULL,
  file_url TEXT NOT NULL,
  provider_name TEXT,
  document_date DATE NOT NULL,
  description TEXT,
  tags TEXT[],
  extracted_text TEXT,
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create patient_visit_summaries table
CREATE TABLE public.patient_visit_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_account_id UUID NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  visit_id UUID REFERENCES public.visits(id),
  visit_date DATE NOT NULL,
  clinic_name TEXT NOT NULL,
  provider_name TEXT,
  chief_complaint TEXT,
  vital_signs JSONB,
  diagnosis TEXT,
  medications JSONB,
  lab_tests JSONB,
  imaging_studies JSONB,
  follow_up_instructions TEXT,
  clinical_notes TEXT,
  summary_pdf_url TEXT,
  source visit_summary_source NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create patient_symptom_logs table
CREATE TABLE public.patient_symptom_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_account_id UUID NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  symptom_data JSONB NOT NULL,
  urgency_level symptom_urgency NOT NULL,
  recommendations TEXT,
  logged_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Add fields to facilities table
ALTER TABLE public.facilities 
ADD COLUMN operating_hours JSONB,
ADD COLUMN accepts_walk_ins BOOLEAN DEFAULT true;

-- Create patient_appointment_requests table
CREATE TABLE public.patient_appointment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_account_id UUID NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  requested_date DATE NOT NULL,
  requested_time_slot TEXT,
  reason TEXT NOT NULL,
  status appointment_status DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS on all new tables
ALTER TABLE public.patient_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_visit_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_symptom_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_appointment_requests ENABLE ROW LEVEL SECURITY;

-- RLS Policies for patient_accounts
CREATE POLICY "Patients can view their own account"
ON public.patient_accounts FOR SELECT
USING (phone_number = current_setting('request.jwt.claims', true)::json->>'phone');

CREATE POLICY "Patients can update their own account"
ON public.patient_accounts FOR UPDATE
USING (phone_number = current_setting('request.jwt.claims', true)::json->>'phone');

CREATE POLICY "Anyone can create patient account"
ON public.patient_accounts FOR INSERT
WITH CHECK (true);

-- RLS Policies for patient_documents
CREATE POLICY "Patients can view their own documents"
ON public.patient_documents FOR SELECT
USING (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

CREATE POLICY "Patients can create their own documents"
ON public.patient_documents FOR INSERT
WITH CHECK (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

CREATE POLICY "Patients can update their own documents"
ON public.patient_documents FOR UPDATE
USING (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

CREATE POLICY "Patients can delete their own documents"
ON public.patient_documents FOR DELETE
USING (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

-- RLS Policies for patient_visit_summaries
CREATE POLICY "Patients can view their own visit summaries"
ON public.patient_visit_summaries FOR SELECT
USING (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

CREATE POLICY "Patients can create manual visit summaries"
ON public.patient_visit_summaries FOR INSERT
WITH CHECK (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
) AND source = 'manual_upload');

CREATE POLICY "System can create link clinic summaries"
ON public.patient_visit_summaries FOR INSERT
WITH CHECK (source = 'link_clinic');

-- RLS Policies for patient_symptom_logs
CREATE POLICY "Patients can view their own symptom logs"
ON public.patient_symptom_logs FOR SELECT
USING (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

CREATE POLICY "Patients can create their own symptom logs"
ON public.patient_symptom_logs FOR INSERT
WITH CHECK (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

-- RLS Policies for patient_appointment_requests
CREATE POLICY "Patients can view their own appointment requests"
ON public.patient_appointment_requests FOR SELECT
USING (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

CREATE POLICY "Patients can create appointment requests"
ON public.patient_appointment_requests FOR INSERT
WITH CHECK (patient_account_id IN (
  SELECT id FROM public.patient_accounts 
  WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
));

CREATE POLICY "Facility staff can view appointment requests"
ON public.patient_appointment_requests FOR SELECT
USING (facility_id = get_user_facility_id());

CREATE POLICY "Facility staff can update appointment requests"
ON public.patient_appointment_requests FOR UPDATE
USING (facility_id = get_user_facility_id());

-- Create storage bucket for patient health records
INSERT INTO storage.buckets (id, name, public) 
VALUES ('patient-health-records', 'patient-health-records', false);

-- Storage policies for patient-health-records bucket
CREATE POLICY "Patients can upload their own documents"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'patient-health-records' AND
  (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.patient_accounts 
    WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
  )
);

CREATE POLICY "Patients can view their own documents"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'patient-health-records' AND
  (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.patient_accounts 
    WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
  )
);

CREATE POLICY "Patients can delete their own documents"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'patient-health-records' AND
  (storage.foldername(name))[1] IN (
    SELECT id::text FROM public.patient_accounts 
    WHERE phone_number = current_setting('request.jwt.claims', true)::json->>'phone'
  )
);

-- Create triggers for updated_at timestamps
CREATE TRIGGER update_patient_accounts_updated_at
BEFORE UPDATE ON public.patient_accounts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_patient_documents_updated_at
BEFORE UPDATE ON public.patient_documents
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_patient_visit_summaries_updated_at
BEFORE UPDATE ON public.patient_visit_summaries
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_patient_appointment_requests_updated_at
BEFORE UPDATE ON public.patient_appointment_requests
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();