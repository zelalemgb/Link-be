-- Create tables for medical orders and results

-- Laboratory Orders table
CREATE TABLE public.lab_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  visit_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  ordered_by UUID NOT NULL,
  test_name TEXT NOT NULL,
  test_code TEXT,
  urgency TEXT NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine', 'urgent', 'stat')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'collected', 'processing', 'completed', 'cancelled')),
  result TEXT,
  result_value TEXT,
  reference_range TEXT,
  notes TEXT,
  ordered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  collected_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Imaging Orders table
CREATE TABLE public.imaging_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  visit_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  ordered_by UUID NOT NULL,
  study_name TEXT NOT NULL,
  study_code TEXT,
  body_part TEXT,
  urgency TEXT NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine', 'urgent', 'stat')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  result TEXT,
  findings TEXT,
  impression TEXT,
  notes TEXT,
  ordered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  scheduled_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Medication Orders table
CREATE TABLE public.medication_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  visit_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  ordered_by UUID NOT NULL,
  medication_name TEXT NOT NULL,
  generic_name TEXT,
  dosage TEXT NOT NULL,
  frequency TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT 'oral' CHECK (route IN ('oral', 'iv', 'im', 'topical', 'inhaled', 'sublingual', 'rectal')),
  duration TEXT,
  quantity INTEGER,
  refills INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispensed', 'administered', 'discontinued', 'cancelled')),
  notes TEXT,
  ordered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  dispensed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.lab_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imaging_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medication_orders ENABLE ROW LEVEL SECURITY;

-- RLS Policies for lab_orders
CREATE POLICY "Medical staff can manage lab orders" ON public.lab_orders
FOR ALL USING (
  EXISTS (SELECT 1 FROM users WHERE users.auth_user_id = auth.uid() AND users.user_role IN ('doctor', 'clinical_officer', 'nurse'))
);

-- RLS Policies for imaging_orders
CREATE POLICY "Medical staff can manage imaging orders" ON public.imaging_orders
FOR ALL USING (
  EXISTS (SELECT 1 FROM users WHERE users.auth_user_id = auth.uid() AND users.user_role IN ('doctor', 'clinical_officer', 'nurse'))
);

-- RLS Policies for medication_orders
CREATE POLICY "Medical staff can manage medication orders" ON public.medication_orders
FOR ALL USING (
  EXISTS (SELECT 1 FROM users WHERE users.auth_user_id = auth.uid() AND users.user_role IN ('doctor', 'clinical_officer', 'nurse'))
);

-- Create indexes for better performance
CREATE INDEX idx_lab_orders_visit_id ON public.lab_orders(visit_id);
CREATE INDEX idx_lab_orders_patient_id ON public.lab_orders(patient_id);
CREATE INDEX idx_lab_orders_status ON public.lab_orders(status);

CREATE INDEX idx_imaging_orders_visit_id ON public.imaging_orders(visit_id);
CREATE INDEX idx_imaging_orders_patient_id ON public.imaging_orders(patient_id);
CREATE INDEX idx_imaging_orders_status ON public.imaging_orders(status);

CREATE INDEX idx_medication_orders_visit_id ON public.medication_orders(visit_id);
CREATE INDEX idx_medication_orders_patient_id ON public.medication_orders(patient_id);
CREATE INDEX idx_medication_orders_status ON public.medication_orders(status);

-- Create triggers for updated_at
CREATE TRIGGER update_lab_orders_updated_at
  BEFORE UPDATE ON public.lab_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_imaging_orders_updated_at
  BEFORE UPDATE ON public.imaging_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_medication_orders_updated_at
  BEFORE UPDATE ON public.medication_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();