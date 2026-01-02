-- Fix security warning: Add search_path to map_role_slug_to_enum function
CREATE OR REPLACE FUNCTION public.map_role_slug_to_enum(role_slug TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Map role slugs to user_role enum values
  RETURN CASE role_slug
    -- Primary admin roles
    WHEN 'super-admin' THEN 'super_admin'
    WHEN 'clinic-admin' THEN 'admin'
    WHEN 'admin' THEN 'admin'
    
    -- Medical staff roles
    WHEN 'doctor' THEN 'doctor'
    WHEN 'clinical-officer' THEN 'clinical_officer'
    WHEN 'clinical_officer' THEN 'clinical_officer'
    WHEN 'nurse' THEN 'nurse'
    WHEN 'inpatient-nurse' THEN 'inpatient_nurse'
    WHEN 'inpatient_nurse' THEN 'inpatient_nurse'
    WHEN 'medical-director' THEN 'medical_director'
    WHEN 'medical_director' THEN 'medical_director'
    WHEN 'nursing-head' THEN 'nursing_head'
    WHEN 'nursing_head' THEN 'nursing_head'
    
    -- Diagnostic services roles
    WHEN 'lab-technician' THEN 'lab_technician'
    WHEN 'lab_technician' THEN 'lab_technician'
    WHEN 'imaging-technician' THEN 'imaging_technician'
    WHEN 'imaging_technician' THEN 'imaging_technician'
    WHEN 'radiologist' THEN 'radiologist'
    
    -- Support roles
    WHEN 'pharmacist' THEN 'pharmacist'
    WHEN 'receptionist' THEN 'receptionist'
    WHEN 'cashier' THEN 'cashier'
    WHEN 'finance' THEN 'finance'
    WHEN 'finance-officer' THEN 'finance'
    WHEN 'logistic-officer' THEN 'logistic_officer'
    WHEN 'logistic_officer' THEN 'logistic_officer'
    
    -- Administrative roles
    WHEN 'rhb' THEN 'rhb'
    WHEN 'hospital-ceo' THEN 'hospital_ceo'
    WHEN 'hospital_ceo' THEN 'hospital_ceo'
    
    -- Default: replace hyphens with underscores as fallback
    ELSE REPLACE(role_slug, '-', '_')
  END;
END;
$$;