-- Correctly assign clinic-admin role to existing facility admins
-- The issue: facilities.admin_user_id is the auth_user_id, not the internal users.id

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
    'migration', 'backfill_clinic_admins_fixed',
    'source', 'facilities.admin_user_id'
  ) as metadata
FROM public.facilities f
JOIN public.users u ON f.admin_user_id = u.auth_user_id  -- FIXED: use auth_user_id instead of id
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

-- Validation
DO $$
DECLARE
  v_total_facilities INTEGER;
  v_admins_with_role INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_total_facilities
  FROM public.facilities
  WHERE admin_user_id IS NOT NULL;
  
  SELECT COUNT(DISTINCT f.id) INTO v_admins_with_role
  FROM public.facilities f
  JOIN public.users u ON f.admin_user_id = u.auth_user_id
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