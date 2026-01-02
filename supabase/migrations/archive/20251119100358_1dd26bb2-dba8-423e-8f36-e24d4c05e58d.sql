-- Step 1: Create a proper role slug to enum mapping function
CREATE OR REPLACE FUNCTION public.map_role_slug_to_enum(role_slug TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
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

-- Step 2: Update the sync trigger to use the mapping function
CREATE OR REPLACE FUNCTION public.sync_rbac_to_user_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role_slug TEXT;
  v_mapped_role TEXT;
BEGIN
  -- Get the user's primary active role
  SELECT r.slug INTO v_role_slug
  FROM public.user_roles ur
  JOIN public.roles r ON ur.role_id = r.id
  WHERE ur.user_id = NEW.user_id
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  ORDER BY 
    CASE r.slug
      WHEN 'super-admin' THEN 1
      WHEN 'clinic-admin' THEN 2
      WHEN 'admin' THEN 2
      WHEN 'medical-director' THEN 3
      WHEN 'medical_director' THEN 3
      ELSE 4
    END
  LIMIT 1;
  
  -- Map slug to enum value using our mapping function
  IF v_role_slug IS NOT NULL THEN
    v_mapped_role := public.map_role_slug_to_enum(v_role_slug);
    
    -- Update the user_role column in users table
    UPDATE public.users
    SET user_role = v_mapped_role::user_role,
        updated_at = NOW()
    WHERE id = NEW.user_id;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Step 3: Now assign clinic-admin role to existing facility admins
INSERT INTO public.user_roles (
  user_id,
  role_id,
  facility_id,
  tenant_id,
  is_active,
  assigned_at,
  metadata
)
SELECT 
  u.id as user_id,
  r.id as role_id,
  f.id as facility_id,
  f.tenant_id,
  true as is_active,
  NOW() as assigned_at,
  jsonb_build_object(
    'is_primary', true, 
    'assigned_by', 'system',
    'migration', 'backfill_clinic_admins',
    'source', 'facilities.admin_user_id'
  ) as metadata
FROM public.facilities f
JOIN public.users u ON f.admin_user_id = u.id
CROSS JOIN public.roles r
WHERE r.slug = 'clinic-admin'
  AND f.admin_user_id IS NOT NULL
  -- Only insert if role assignment doesn't already exist
  AND NOT EXISTS (
    SELECT 1 
    FROM public.user_roles ur
    WHERE ur.user_id = u.id 
      AND ur.role_id = r.id
      AND ur.facility_id = f.id
  );

-- Step 4: Validation - verify all facility admins now have the clinic-admin role
DO $$
DECLARE
  v_total_facilities INTEGER;
  v_facilities_with_admin INTEGER;
  v_admins_with_role INTEGER;
BEGIN
  -- Count facilities with admin_user_id
  SELECT COUNT(*) INTO v_total_facilities
  FROM public.facilities
  WHERE admin_user_id IS NOT NULL;
  
  -- Count how many have matching role assignments
  SELECT COUNT(DISTINCT f.id) INTO v_admins_with_role
  FROM public.facilities f
  JOIN public.users u ON f.admin_user_id = u.id
  JOIN public.user_roles ur ON ur.user_id = u.id AND ur.facility_id = f.id
  JOIN public.roles r ON ur.role_id = r.id
  WHERE r.slug = 'clinic-admin'
    AND ur.is_active = true
    AND f.admin_user_id IS NOT NULL;
  
  RAISE NOTICE 'Migration validation:';
  RAISE NOTICE '  Total facilities with admin_user_id: %', v_total_facilities;
  RAISE NOTICE '  Facilities with clinic-admin role assigned: %', v_admins_with_role;
  
  IF v_total_facilities != v_admins_with_role THEN
    RAISE WARNING 'Mismatch detected: % facilities missing clinic-admin role', 
      (v_total_facilities - v_admins_with_role);
  ELSE
    RAISE NOTICE 'SUCCESS: All facility admins have been assigned the clinic-admin role';
  END IF;
END;
$$;