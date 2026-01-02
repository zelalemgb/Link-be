-- Phase 5: Complete migration from old user_role to new RBAC system

-- Step 1: Helper function to get role_id by slug
CREATE OR REPLACE FUNCTION public.get_role_id_by_slug(role_slug TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role_id UUID;
BEGIN
  SELECT id INTO v_role_id
  FROM public.roles
  WHERE slug = role_slug
  LIMIT 1;
  
  RETURN v_role_id;
END;
$$;

-- Step 2: Migrate existing users to new RBAC system
DO $$
DECLARE
  user_record RECORD;
  v_role_id UUID;
  v_facility_id UUID;
  v_tenant_id UUID;
BEGIN
  -- Loop through all users with a user_role set
  FOR user_record IN 
    SELECT id, user_role::TEXT, facility_id, tenant_id
    FROM public.users
    WHERE user_role IS NOT NULL
  LOOP
    -- Get the role_id from the slug
    v_role_id := public.get_role_id_by_slug(user_record.user_role);
    
    IF v_role_id IS NULL THEN
      RAISE NOTICE 'Role not found for slug: %', user_record.user_role;
      CONTINUE;
    END IF;
    
    -- Use facility_id and tenant_id from user record
    v_facility_id := user_record.facility_id;
    v_tenant_id := user_record.tenant_id;
    
    -- Insert into user_roles (skip if already exists)
    INSERT INTO public.user_roles (
      user_id,
      role_id,
      facility_id,
      tenant_id,
      assigned_by,
      assigned_at,
      is_active
    )
    VALUES (
      user_record.id,
      v_role_id,
      v_facility_id,
      v_tenant_id,
      user_record.id, -- Self-assigned during migration
      NOW(),
      true
    )
    ON CONFLICT (user_id, role_id, facility_id) DO NOTHING;
    
  END LOOP;
END $$;

-- Step 3: Update has_role function to use new RBAC system only
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role TEXT)
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
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  )
$$;

-- Step 4: Update has_role function with app_role enum for backward compatibility
CREATE OR REPLACE FUNCTION public.has_role(_role app_role)
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
      AND r.slug = _role::TEXT
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  )
$$;

-- Step 5: Update is_super_admin function to use new RBAC system only
CREATE OR REPLACE FUNCTION public.is_super_admin()
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
      AND r.slug = 'super_admin'
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  )
$$;

-- Step 6: Update get_current_user_role to use new RBAC system only
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS app_role
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role_slug TEXT;
BEGIN
  SELECT r.slug INTO v_role_slug
  FROM public.user_roles ur
  JOIN public.roles r ON ur.role_id = r.id
  JOIN public.users u ON ur.user_id = u.id
  WHERE u.auth_user_id = auth.uid()
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  ORDER BY 
    CASE r.slug
      WHEN 'super_admin' THEN 1
      WHEN 'admin' THEN 2
      WHEN 'medical_director' THEN 3
      ELSE 4
    END
  LIMIT 1;
  
  IF v_role_slug IS NULL THEN
    RETURN NULL;
  END IF;
  
  RETURN v_role_slug::app_role;
END;
$$;

-- Step 7: Create function to get user's current role as text
CREATE OR REPLACE FUNCTION public.get_current_user_role_text()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.slug
  FROM public.user_roles ur
  JOIN public.roles r ON ur.role_id = r.id
  JOIN public.users u ON ur.user_id = u.id
  WHERE u.auth_user_id = auth.uid()
    AND ur.is_active = true
    AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
  ORDER BY 
    CASE r.slug
      WHEN 'super_admin' THEN 1
      WHEN 'admin' THEN 2
      WHEN 'medical_director' THEN 3
      ELSE 4
    END
  LIMIT 1
$$;

-- Step 8: Create trigger to keep old user_role column in sync (for safety during transition)
CREATE OR REPLACE FUNCTION public.sync_rbac_to_user_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role_slug TEXT;
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
      WHEN 'super_admin' THEN 1
      WHEN 'admin' THEN 2
      WHEN 'medical_director' THEN 3
      ELSE 4
    END
  LIMIT 1;
  
  -- Update the user_role column in users table
  IF v_role_slug IS NOT NULL THEN
    UPDATE public.users
    SET user_role = v_role_slug::user_role,
        updated_at = NOW()
    WHERE id = NEW.user_id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on user_roles table
DROP TRIGGER IF EXISTS sync_rbac_to_user_role_trigger ON public.user_roles;
CREATE TRIGGER sync_rbac_to_user_role_trigger
AFTER INSERT OR UPDATE ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.sync_rbac_to_user_role();

-- Step 9: Validation query to check migration success
DO $$
DECLARE
  v_total_users INTEGER;
  v_migrated_users INTEGER;
  v_missing_users INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_total_users
  FROM public.users
  WHERE user_role IS NOT NULL;
  
  SELECT COUNT(DISTINCT user_id) INTO v_migrated_users
  FROM public.user_roles
  WHERE is_active = true;
  
  v_missing_users := v_total_users - v_migrated_users;
  
  RAISE NOTICE '=== Migration Summary ===';
  RAISE NOTICE 'Total users with roles: %', v_total_users;
  RAISE NOTICE 'Users migrated to RBAC: %', v_migrated_users;
  RAISE NOTICE 'Users not migrated: %', v_missing_users;
  
  IF v_missing_users > 0 THEN
    RAISE WARNING 'Some users were not migrated. Please review manually.';
  ELSE
    RAISE NOTICE 'All users successfully migrated to RBAC system!';
  END IF;
END $$;