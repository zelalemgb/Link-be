-- Phase 6.1: Create Additional RBAC Helper Functions for RLS Policies

-- Function 1: Check if user has ANY of multiple roles
CREATE OR REPLACE FUNCTION public.has_any_role(_user_id UUID, _roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON ur.role_id = r.id
    WHERE ur.user_id = _user_id
      AND r.slug = ANY(_roles)
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  )
$$;

-- Function 2: Check if current user has ANY of multiple roles (auth.uid() version)
CREATE OR REPLACE FUNCTION public.current_user_has_any_role(_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON ur.role_id = r.id
    JOIN public.users u ON ur.user_id = u.id
    WHERE u.auth_user_id = auth.uid()
      AND r.slug = ANY(_roles)
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  )
$$;

-- Function 3: Check if user has role at specific facility
CREATE OR REPLACE FUNCTION public.has_role_at_facility(_user_id UUID, _role TEXT, _facility_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON ur.role_id = r.id
    WHERE ur.user_id = _user_id
      AND r.slug = _role
      AND ur.facility_id = _facility_id
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  )
$$;

-- Function 4: Get all facility IDs for current user
CREATE OR REPLACE FUNCTION public.get_user_facility_ids()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY_AGG(DISTINCT ur.facility_id)
  FROM public.user_roles ur
  JOIN public.users u ON ur.user_id = u.id
  WHERE u.auth_user_id = auth.uid()
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
    AND ur.facility_id IS NOT NULL
$$;

-- Function 5: Check if user can access patient data (combines facility + clinical roles)
CREATE OR REPLACE FUNCTION public.can_access_patient_data()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'doctor', 'nurse', 'clinical_officer', 'receptionist',
      'lab_technician', 'imaging_technician', 'radiologist',
      'pharmacist', 'admin', 'medical_director', 'nursing_head',
      'finance', 'cashier'
    ])
$$;

-- Function 6: Check if user can create orders
CREATE OR REPLACE FUNCTION public.can_create_orders()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'doctor', 'clinical_officer', 'nurse'
    ])
$$;

-- Function 7: Check if user can view billing data
CREATE OR REPLACE FUNCTION public.can_view_billing()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'finance', 'cashier', 'admin', 'hospital_ceo', 
      'medical_director', 'finance_officer'
    ])
$$;

-- Function 8: Check if user can manage master data
CREATE OR REPLACE FUNCTION public.can_manage_master_data()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'admin', 'hospital_ceo', 'medical_director'
    ])
$$;

-- Function 9: Check if user is facility admin
CREATE OR REPLACE FUNCTION public.is_facility_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'admin', 'hospital_ceo'
    ])
$$;

-- Function 10: Check if user can manage admissions
CREATE OR REPLACE FUNCTION public.can_manage_admissions()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'doctor', 'clinical_officer', 'nurse', 'admin',
      'medical_director', 'nursing_head'
    ])
$$;

-- Function 11: Check if user can view lab results
CREATE OR REPLACE FUNCTION public.can_view_lab_results()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'doctor', 'clinical_officer', 'nurse', 'lab_technician',
      'medical_director'
    ])
$$;

-- Function 12: Check if user can manage lab orders
CREATE OR REPLACE FUNCTION public.can_manage_lab_orders()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'doctor', 'clinical_officer', 'nurse', 'lab_technician'
    ])
$$;

-- Function 13: Check if user can view imaging results
CREATE OR REPLACE FUNCTION public.can_view_imaging_results()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'doctor', 'clinical_officer', 'nurse', 'imaging_technician',
      'radiologist', 'medical_director'
    ])
$$;

-- Function 14: Check if user can manage imaging orders
CREATE OR REPLACE FUNCTION public.can_manage_imaging_orders()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'doctor', 'clinical_officer', 'nurse', 'imaging_technician', 'radiologist'
    ])
$$;

-- Function 15: Check if user can dispense medication
CREATE OR REPLACE FUNCTION public.can_dispense_medication()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'pharmacist', 'nurse', 'doctor', 'clinical_officer'
    ])
$$;

-- Function 16: Check if user can manage inventory
CREATE OR REPLACE FUNCTION public.can_manage_inventory()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'logistic_officer', 'pharmacist', 'admin', 'hospital_ceo'
    ])
$$;

-- Function 17: Check if user is clinical staff
CREATE OR REPLACE FUNCTION public.is_clinical_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    is_super_admin() 
    OR current_user_has_any_role(ARRAY[
      'doctor', 'clinical_officer', 'nurse', 'nursing_head', 'medical_director'
    ])
$$;

-- Add comments for documentation
COMMENT ON FUNCTION public.has_any_role(UUID, TEXT[]) IS 'Check if specific user has any of the given roles';
COMMENT ON FUNCTION public.current_user_has_any_role(TEXT[]) IS 'Check if current authenticated user has any of the given roles';
COMMENT ON FUNCTION public.has_role_at_facility(UUID, TEXT, UUID) IS 'Check if user has specific role at specific facility';
COMMENT ON FUNCTION public.get_user_facility_ids() IS 'Get all facility IDs where current user has roles';
COMMENT ON FUNCTION public.can_access_patient_data() IS 'Check if user can view patient data (any clinical or admin role)';
COMMENT ON FUNCTION public.can_create_orders() IS 'Check if user can create lab/imaging/medication orders';
COMMENT ON FUNCTION public.can_view_billing() IS 'Check if user can view billing and payment data';
COMMENT ON FUNCTION public.can_manage_master_data() IS 'Check if user can manage master data (services, programs, etc)';
COMMENT ON FUNCTION public.is_facility_admin() IS 'Check if user is facility administrator';
COMMENT ON FUNCTION public.can_manage_admissions() IS 'Check if user can manage patient admissions';
COMMENT ON FUNCTION public.can_view_lab_results() IS 'Check if user can view laboratory results';
COMMENT ON FUNCTION public.can_manage_lab_orders() IS 'Check if user can create/update lab orders';
COMMENT ON FUNCTION public.can_view_imaging_results() IS 'Check if user can view imaging results';
COMMENT ON FUNCTION public.can_manage_imaging_orders() IS 'Check if user can create/update imaging orders';
COMMENT ON FUNCTION public.can_dispense_medication() IS 'Check if user can dispense medications';
COMMENT ON FUNCTION public.can_manage_inventory() IS 'Check if user can manage inventory/stock';
COMMENT ON FUNCTION public.is_clinical_staff() IS 'Check if user is clinical staff (doctor, nurse, clinical officer)';