-- Phase 4: Inpatient Management System

-- Step 1: Create departments table
CREATE TABLE IF NOT EXISTS public.departments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  
  name TEXT NOT NULL,
  code TEXT, -- e.g., 'ICU', 'PEDS', 'OB'
  department_type TEXT NOT NULL CHECK (department_type IN ('emergency', 'icu', 'medical', 'surgical', 'pediatric', 'maternity', 'nicu', 'psychiatric', 'rehabilitation', 'outpatient')),
  
  -- Capacity
  total_beds INTEGER DEFAULT 0,
  available_beds INTEGER DEFAULT 0,
  occupied_beds INTEGER DEFAULT 0,
  
  -- Management
  head_nurse_id UUID REFERENCES public.users(id),
  medical_director_id UUID REFERENCES public.users(id),
  
  is_active BOOLEAN DEFAULT true,
  accepts_admissions BOOLEAN DEFAULT true,
  accepts_transfers BOOLEAN DEFAULT true,
  
  -- Contact
  phone_extension TEXT,
  location_floor TEXT,
  location_building TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  UNIQUE (tenant_id, facility_id, code)
);

-- Create indexes for departments
CREATE INDEX IF NOT EXISTS idx_departments_tenant_id ON public.departments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_departments_facility_id ON public.departments(facility_id);
CREATE INDEX IF NOT EXISTS idx_departments_type ON public.departments(department_type);
CREATE INDEX IF NOT EXISTS idx_departments_active ON public.departments(is_active);

-- Enable RLS on departments
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- Step 2: Create wards table
CREATE TABLE IF NOT EXISTS public.wards (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,
  code TEXT,
  ward_type TEXT CHECK (ward_type IN ('general', 'isolation', 'semi_private', 'private', 'observation')),
  
  -- Capacity tracking
  total_beds INTEGER DEFAULT 0,
  available_beds INTEGER DEFAULT 0,
  occupied_beds INTEGER DEFAULT 0,
  cleaning_beds INTEGER DEFAULT 0,
  
  -- Ward characteristics
  gender_restriction TEXT CHECK (gender_restriction IN ('male', 'female', 'mixed', 'pediatric')),
  min_age INTEGER,
  max_age INTEGER,
  
  -- Management
  nurse_in_charge_id UUID REFERENCES public.users(id),
  
  is_active BOOLEAN DEFAULT true,
  accepts_admissions BOOLEAN DEFAULT true,
  
  location_floor TEXT,
  location_wing TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  UNIQUE (tenant_id, facility_id, department_id, code)
);

-- Create indexes for wards
CREATE INDEX IF NOT EXISTS idx_wards_tenant_id ON public.wards(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wards_facility_id ON public.wards(facility_id);
CREATE INDEX IF NOT EXISTS idx_wards_department_id ON public.wards(department_id);
CREATE INDEX IF NOT EXISTS idx_wards_active ON public.wards(is_active);

-- Enable RLS on wards
ALTER TABLE public.wards ENABLE ROW LEVEL SECURITY;

-- Step 3: Create beds table
CREATE TABLE IF NOT EXISTS public.beds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  department_id UUID NOT NULL REFERENCES public.departments(id),
  ward_id UUID NOT NULL REFERENCES public.wards(id) ON DELETE CASCADE,
  
  bed_number TEXT NOT NULL,
  bed_label TEXT, -- Display name like "Bed A1"
  bed_type TEXT CHECK (bed_type IN ('standard', 'icu', 'isolation', 'pediatric', 'nicu', 'delivery', 'observation')),
  
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'OCCUPIED', 'CLEANING', 'MAINTENANCE', 'RESERVED', 'BLOCKED')),
  
  -- Equipment flags
  has_oxygen BOOLEAN DEFAULT false,
  has_suction BOOLEAN DEFAULT false,
  has_monitor BOOLEAN DEFAULT false,
  has_ventilator BOOLEAN DEFAULT false,
  
  -- Current occupancy
  current_admission_id UUID,
  occupied_since TIMESTAMP WITH TIME ZONE,
  
  is_active BOOLEAN DEFAULT true,
  
  notes TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  UNIQUE (tenant_id, facility_id, ward_id, bed_number)
);

-- Create indexes for beds
CREATE INDEX IF NOT EXISTS idx_beds_tenant_id ON public.beds(tenant_id);
CREATE INDEX IF NOT EXISTS idx_beds_facility_id ON public.beds(facility_id);
CREATE INDEX IF NOT EXISTS idx_beds_ward_id ON public.beds(ward_id);
CREATE INDEX IF NOT EXISTS idx_beds_status ON public.beds(status);
CREATE INDEX IF NOT EXISTS idx_beds_current_admission ON public.beds(current_admission_id);

-- Enable RLS on beds
ALTER TABLE public.beds ENABLE ROW LEVEL SECURITY;

-- Step 4: Create admissions table (separate from visits)
CREATE TABLE IF NOT EXISTS public.admissions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  
  -- Admission details
  admission_number TEXT NOT NULL, -- Auto-generated unique admission ID
  admission_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  admission_type TEXT NOT NULL CHECK (admission_type IN ('emergency', 'elective', 'transfer_in', 'observation', 'day_surgery', 'readmission')),
  admission_source TEXT CHECK (admission_source IN ('emergency', 'outpatient', 'transfer', 'direct', 'referral')),
  
  -- Location
  department_id UUID REFERENCES public.departments(id),
  ward_id UUID REFERENCES public.wards(id),
  bed_id UUID REFERENCES public.beds(id),
  
  -- Clinical
  admitting_doctor_id UUID NOT NULL REFERENCES public.users(id),
  attending_doctor_id UUID REFERENCES public.users(id),
  admitting_diagnosis TEXT,
  admitting_diagnosis_codes TEXT[],
  chief_complaint TEXT,
  
  -- Related visit (if admitted from OPD)
  source_visit_id UUID REFERENCES public.visits(id),
  
  -- Status
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discharged', 'transferred_out', 'absconded', 'deceased', 'cancelled')),
  
  -- Discharge information
  discharge_date TIMESTAMP WITH TIME ZONE,
  discharge_type TEXT CHECK (discharge_type IN ('routine', 'against_advice', 'transfer', 'deceased', 'absconded')),
  discharge_diagnosis TEXT,
  discharge_diagnosis_codes TEXT[],
  discharge_summary TEXT,
  discharge_instructions TEXT,
  discharged_by UUID REFERENCES public.users(id),
  
  -- Length of stay tracking
  planned_los_days INTEGER,
  actual_los_days INTEGER,
  
  -- Financial
  total_charges NUMERIC DEFAULT 0,
  insurance_status TEXT,
  payment_type TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  UNIQUE (tenant_id, facility_id, admission_number)
);

-- Create indexes for admissions
CREATE INDEX IF NOT EXISTS idx_admissions_tenant_id ON public.admissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admissions_facility_id ON public.admissions(facility_id);
CREATE INDEX IF NOT EXISTS idx_admissions_patient_id ON public.admissions(patient_id);
CREATE INDEX IF NOT EXISTS idx_admissions_bed_id ON public.admissions(bed_id);
CREATE INDEX IF NOT EXISTS idx_admissions_status ON public.admissions(status);
CREATE INDEX IF NOT EXISTS idx_admissions_admission_date ON public.admissions(admission_date DESC);
CREATE INDEX IF NOT EXISTS idx_admissions_number ON public.admissions(admission_number);

-- Enable RLS on admissions
ALTER TABLE public.admissions ENABLE ROW LEVEL SECURITY;

-- Step 5: Create waitlist table
CREATE TABLE IF NOT EXISTS public.waitlist (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  
  department_id UUID NOT NULL REFERENCES public.departments(id),
  preferred_ward_id UUID REFERENCES public.wards(id),
  
  -- Request details
  requested_by UUID NOT NULL REFERENCES public.users(id),
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
  
  admission_type TEXT CHECK (admission_type IN ('emergency', 'elective', 'transfer_in', 'observation')),
  reason TEXT NOT NULL,
  diagnosis TEXT,
  
  -- Related entities
  source_visit_id UUID REFERENCES public.visits(id),
  
  -- Status
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'admitted', 'cancelled', 'expired')),
  
  -- Resolution
  admission_id UUID REFERENCES public.admissions(id),
  admitted_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  cancelled_by UUID REFERENCES public.users(id),
  cancellation_reason TEXT,
  
  -- Notification
  last_notified_at TIMESTAMP WITH TIME ZONE,
  notification_attempts INTEGER DEFAULT 0,
  
  notes TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for waitlist
CREATE INDEX IF NOT EXISTS idx_waitlist_tenant_id ON public.waitlist(tenant_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_facility_id ON public.waitlist(facility_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_department_id ON public.waitlist(department_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_patient_id ON public.waitlist(patient_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON public.waitlist(status);
CREATE INDEX IF NOT EXISTS idx_waitlist_priority_requested ON public.waitlist(priority, requested_at);

-- Enable RLS on waitlist
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Step 6: Create ipd_tasks table (nursing worklist)
CREATE TABLE IF NOT EXISTS public.ipd_tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  admission_id UUID NOT NULL REFERENCES public.admissions(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  
  task_type TEXT NOT NULL CHECK (task_type IN ('vital_signs', 'medication', 'iv_fluids', 'wound_care', 'intake_output', 'turning', 'feeding', 'assessment', 'lab_draw', 'imaging', 'procedure', 'discharge_prep', 'other')),
  task_title TEXT NOT NULL,
  task_description TEXT,
  
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  
  -- Scheduling
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
  due_at TIMESTAMP WITH TIME ZONE,
  
  -- Assignment
  assigned_to UUID REFERENCES public.users(id),
  created_by UUID NOT NULL REFERENCES public.users(id),
  
  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped', 'cancelled')),
  
  -- Completion
  completed_at TIMESTAMP WITH TIME ZONE,
  completed_by UUID REFERENCES public.users(id),
  completion_notes TEXT,
  
  -- Recurrence
  is_recurring BOOLEAN DEFAULT false,
  recurrence_pattern TEXT, -- 'every_4_hours', 'daily', 'twice_daily', etc.
  next_occurrence_id UUID,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for ipd_tasks
CREATE INDEX IF NOT EXISTS idx_ipd_tasks_tenant_id ON public.ipd_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ipd_tasks_admission_id ON public.ipd_tasks(admission_id);
CREATE INDEX IF NOT EXISTS idx_ipd_tasks_patient_id ON public.ipd_tasks(patient_id);
CREATE INDEX IF NOT EXISTS idx_ipd_tasks_assigned_to ON public.ipd_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_ipd_tasks_status ON public.ipd_tasks(status);
CREATE INDEX IF NOT EXISTS idx_ipd_tasks_scheduled_at ON public.ipd_tasks(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_ipd_tasks_priority_scheduled ON public.ipd_tasks(priority, scheduled_at);

-- Enable RLS on ipd_tasks
ALTER TABLE public.ipd_tasks ENABLE ROW LEVEL SECURITY;

-- Step 7: Create ipd_charges table (centralized billing ledger)
CREATE TABLE IF NOT EXISTS public.ipd_charges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  admission_id UUID NOT NULL REFERENCES public.admissions(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  
  charge_type TEXT NOT NULL CHECK (charge_type IN ('bed_charge', 'consultation', 'medication', 'lab_test', 'imaging', 'procedure', 'surgery', 'nursing_care', 'medical_supply', 'diet', 'other')),
  
  service_id UUID REFERENCES public.medical_services(id),
  service_name TEXT NOT NULL,
  service_description TEXT,
  
  quantity NUMERIC NOT NULL DEFAULT 1,
  unit_price NUMERIC NOT NULL,
  total_amount NUMERIC NOT NULL,
  
  -- Billing period (for recurring charges like bed charges)
  charge_date DATE NOT NULL DEFAULT CURRENT_DATE,
  charge_start_datetime TIMESTAMP WITH TIME ZONE,
  charge_end_datetime TIMESTAMP WITH TIME ZONE,
  
  -- Authorization
  ordered_by UUID REFERENCES public.users(id),
  posted_by UUID NOT NULL REFERENCES public.users(id),
  posted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Related entities
  related_order_id UUID, -- Link to patient_orders if applicable
  related_task_id UUID REFERENCES public.ipd_tasks(id),
  
  -- Payment
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid', 'waived', 'disputed')),
  amount_paid NUMERIC DEFAULT 0,
  
  is_cancelled BOOLEAN DEFAULT false,
  cancelled_by UUID REFERENCES public.users(id),
  cancelled_at TIMESTAMP WITH TIME ZONE,
  cancellation_reason TEXT,
  
  notes TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for ipd_charges
CREATE INDEX IF NOT EXISTS idx_ipd_charges_tenant_id ON public.ipd_charges(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ipd_charges_admission_id ON public.ipd_charges(admission_id);
CREATE INDEX IF NOT EXISTS idx_ipd_charges_patient_id ON public.ipd_charges(patient_id);
CREATE INDEX IF NOT EXISTS idx_ipd_charges_charge_date ON public.ipd_charges(charge_date DESC);
CREATE INDEX IF NOT EXISTS idx_ipd_charges_payment_status ON public.ipd_charges(payment_status);
CREATE INDEX IF NOT EXISTS idx_ipd_charges_type ON public.ipd_charges(charge_type);

-- Enable RLS on ipd_charges
ALTER TABLE public.ipd_charges ENABLE ROW LEVEL SECURITY;

-- Step 8: Add foreign key constraint from beds to admissions
ALTER TABLE public.beds
  ADD CONSTRAINT fk_beds_current_admission 
  FOREIGN KEY (current_admission_id) 
  REFERENCES public.admissions(id) 
  ON DELETE SET NULL;

-- Step 9: Create function to generate admission numbers
CREATE OR REPLACE FUNCTION public.generate_admission_number(p_facility_id UUID, p_admission_date TIMESTAMP WITH TIME ZONE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_date_part TEXT;
  v_sequence INT;
  v_admission_number TEXT;
BEGIN
  -- Format: ADM-YYYYMMDD-NNNN
  v_date_part := TO_CHAR(p_admission_date, 'YYYYMMDD');
  
  -- Get next sequence for this date
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(admission_number FROM '\d{4}$') AS INTEGER)
  ), 0) + 1
  INTO v_sequence
  FROM public.admissions
  WHERE facility_id = p_facility_id
    AND admission_number LIKE 'ADM-' || v_date_part || '-%';
  
  v_admission_number := 'ADM-' || v_date_part || '-' || LPAD(v_sequence::TEXT, 4, '0');
  
  RETURN v_admission_number;
END;
$$;

-- Step 10: Create trigger to auto-generate admission numbers
CREATE OR REPLACE FUNCTION public.set_admission_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.admission_number IS NULL OR NEW.admission_number = '' THEN
    NEW.admission_number := public.generate_admission_number(NEW.facility_id, NEW.admission_date);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_set_admission_number
  BEFORE INSERT ON public.admissions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_admission_number();

-- Step 11: Create RLS policies for all tables

-- Departments policies
CREATE POLICY "Facility staff can view departments" ON public.departments
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Admin can manage departments" ON public.departments
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('hospital_ceo', 'medical_director', 'nursing_head', 'super_admin')
    )
  );

-- Wards policies
CREATE POLICY "Facility staff can view wards" ON public.wards
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Admin can manage wards" ON public.wards
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('hospital_ceo', 'medical_director', 'nursing_head', 'super_admin')
    )
  );

-- Beds policies
CREATE POLICY "Facility staff can view beds" ON public.beds
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Nurses can update beds" ON public.beds
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('nurse', 'nursing_head', 'doctor', 'super_admin')
    )
  );

CREATE POLICY "Admin can manage beds" ON public.beds
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('hospital_ceo', 'nursing_head', 'super_admin')
    )
  );

-- Admissions policies
CREATE POLICY "Facility staff can view admissions" ON public.admissions
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Doctors can create admissions" ON public.admissions
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'super_admin')
    )
  );

CREATE POLICY "Doctors can update admissions" ON public.admissions
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'nurse', 'nursing_head', 'super_admin')
    )
  );

-- Waitlist policies
CREATE POLICY "Facility staff can view waitlist" ON public.waitlist
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Clinical staff can manage waitlist" ON public.waitlist
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'nurse', 'receptionist', 'super_admin')
    )
  );

-- IPD Tasks policies
CREATE POLICY "Ward staff can view ipd tasks" ON public.ipd_tasks
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Nurses can manage ipd tasks" ON public.ipd_tasks
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('nurse', 'nursing_head', 'doctor', 'clinical_officer', 'super_admin')
    )
  );

-- IPD Charges policies
CREATE POLICY "Facility staff can view ipd charges" ON public.ipd_charges
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Finance and clinical can create charges" ON public.ipd_charges
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('finance', 'doctor', 'clinical_officer', 'nurse', 'super_admin')
    )
  );

CREATE POLICY "Finance can update charges" ON public.ipd_charges
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('finance', 'super_admin')
    )
  );

-- Step 12: Create triggers for updated_at
CREATE TRIGGER update_departments_updated_at
  BEFORE UPDATE ON public.departments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_wards_updated_at
  BEFORE UPDATE ON public.wards
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_beds_updated_at
  BEFORE UPDATE ON public.beds
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_admissions_updated_at
  BEFORE UPDATE ON public.admissions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_waitlist_updated_at
  BEFORE UPDATE ON public.waitlist
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_ipd_tasks_updated_at
  BEFORE UPDATE ON public.ipd_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_ipd_charges_updated_at
  BEFORE UPDATE ON public.ipd_charges
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Step 13: Add documentation comments
COMMENT ON TABLE public.departments IS 'Organizational departments within facilities - ICU, Pediatrics, Maternity, etc.';
COMMENT ON TABLE public.wards IS 'Physical ward locations within departments - contains multiple beds';
COMMENT ON TABLE public.beds IS 'Individual beds with real-time status tracking - AVAILABLE, OCCUPIED, CLEANING, etc.';
COMMENT ON TABLE public.admissions IS 'Inpatient admission episodes - separate from outpatient visits';
COMMENT ON TABLE public.waitlist IS 'Queue for pending admissions when department capacity is full';
COMMENT ON TABLE public.ipd_tasks IS 'Nursing worklist - vital signs, medications, procedures, etc.';
COMMENT ON TABLE public.ipd_charges IS 'Centralized billing ledger for inpatient charges - wards are read-only';