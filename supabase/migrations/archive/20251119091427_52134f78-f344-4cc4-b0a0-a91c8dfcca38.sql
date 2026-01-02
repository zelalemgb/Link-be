-- Fix the sync trigger to handle slug-to-enum mapping
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
      WHEN 'admin' THEN 2
      WHEN 'medical_director' THEN 3
      ELSE 4
    END
  LIMIT 1;
  
  -- Map slug to enum value (replace hyphens with underscores)
  IF v_role_slug IS NOT NULL THEN
    v_mapped_role := REPLACE(v_role_slug, '-', '_');
    
    -- Update the user_role column in users table
    UPDATE public.users
    SET user_role = v_mapped_role::user_role,
        updated_at = NOW()
    WHERE id = NEW.user_id;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Now assign super_admin role to the existing super admin user
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
  u.facility_id,
  u.tenant_id,
  true as is_active,
  NOW() as assigned_at,
  jsonb_build_object('is_primary', true, 'assigned_by', 'system') as metadata
FROM public.users u
CROSS JOIN public.roles r
WHERE u.user_role = 'super_admin'
  AND r.slug = 'super-admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = u.id AND ur.role_id = r.id
  );