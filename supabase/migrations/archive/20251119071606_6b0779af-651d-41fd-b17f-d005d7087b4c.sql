-- Phase 3: Admin Management System with Audit Trails (Fixed)

-- Function to assign a role to a user
CREATE OR REPLACE FUNCTION public.assign_user_role(
  p_user_id UUID,
  p_role_id UUID,
  p_facility_id UUID DEFAULT NULL,
  p_assigned_by UUID DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_assignment_id UUID;
  v_tenant_id UUID;
  v_assigner_id UUID;
BEGIN
  -- Get the assigner's ID (defaults to current user)
  v_assigner_id := COALESCE(p_assigned_by, auth.uid());
  
  -- Get tenant_id from user
  SELECT tenant_id INTO v_tenant_id
  FROM public.users
  WHERE id = p_user_id;
  
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'User not found or has no tenant';
  END IF;
  
  -- Insert or update the role assignment
  INSERT INTO public.user_roles (
    user_id,
    role_id,
    facility_id,
    tenant_id,
    assigned_by,
    expires_at,
    metadata,
    is_active
  ) VALUES (
    p_user_id,
    p_role_id,
    p_facility_id,
    v_tenant_id,
    v_assigner_id,
    p_expires_at,
    p_metadata,
    true
  )
  ON CONFLICT (user_id, role_id, COALESCE(facility_id, '00000000-0000-0000-0000-000000000000'::UUID))
  DO UPDATE SET
    is_active = true,
    assigned_by = v_assigner_id,
    expires_at = p_expires_at,
    metadata = p_metadata,
    updated_at = now()
  RETURNING id INTO v_assignment_id;
  
  RETURN v_assignment_id;
END;
$$;

-- Function to revoke a role from a user
CREATE OR REPLACE FUNCTION public.revoke_user_role(
  p_user_id UUID,
  p_role_id UUID,
  p_facility_id UUID DEFAULT NULL,
  p_revoked_by UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revoker_id UUID;
  v_rows_affected INTEGER;
BEGIN
  -- Get the revoker's ID (defaults to current user)
  v_revoker_id := COALESCE(p_revoked_by, auth.uid());
  
  -- Deactivate the role assignment
  UPDATE public.user_roles
  SET 
    is_active = false,
    assigned_by = v_revoker_id,
    updated_at = now()
  WHERE user_id = p_user_id
    AND role_id = p_role_id
    AND (
      (p_facility_id IS NULL AND facility_id IS NULL)
      OR facility_id = p_facility_id
    );
  
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  
  RETURN v_rows_affected > 0;
END;
$$;

-- Function to update role assignment metadata
CREATE OR REPLACE FUNCTION public.update_user_role(
  p_user_id UUID,
  p_role_id UUID,
  p_facility_id UUID DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL,
  p_updated_by UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updater_id UUID;
  v_rows_affected INTEGER;
BEGIN
  -- Get the updater's ID (defaults to current user)
  v_updater_id := COALESCE(p_updated_by, auth.uid());
  
  -- Update the role assignment
  UPDATE public.user_roles
  SET 
    expires_at = COALESCE(p_expires_at, expires_at),
    metadata = COALESCE(p_metadata, metadata),
    assigned_by = v_updater_id,
    updated_at = now()
  WHERE user_id = p_user_id
    AND role_id = p_role_id
    AND (
      (p_facility_id IS NULL AND facility_id IS NULL)
      OR facility_id = p_facility_id
    )
    AND is_active = true;
  
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  
  RETURN v_rows_affected > 0;
END;
$$;

-- Function to assign a permission to a role
CREATE OR REPLACE FUNCTION public.assign_permission_to_role(
  p_role_id UUID,
  p_permission_id UUID,
  p_metadata JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_assignment_id UUID;
BEGIN
  -- Insert or update the role-permission assignment
  INSERT INTO public.role_permissions (
    role_id,
    permission_id,
    metadata
  ) VALUES (
    p_role_id,
    p_permission_id,
    p_metadata
  )
  ON CONFLICT (role_id, permission_id)
  DO UPDATE SET
    metadata = p_metadata,
    updated_at = now()
  RETURNING id INTO v_assignment_id;
  
  RETURN v_assignment_id;
END;
$$;

-- Function to revoke a permission from a role
CREATE OR REPLACE FUNCTION public.revoke_permission_from_role(
  p_role_id UUID,
  p_permission_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows_affected INTEGER;
BEGIN
  -- Delete the role-permission assignment
  DELETE FROM public.role_permissions
  WHERE role_id = p_role_id
    AND permission_id = p_permission_id;
  
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  
  RETURN v_rows_affected > 0;
END;
$$;

-- Function to get all role assignments for a user
CREATE OR REPLACE FUNCTION public.get_user_role_assignments(
  p_user_id UUID,
  p_include_inactive BOOLEAN DEFAULT false
)
RETURNS TABLE (
  assignment_id UUID,
  role_id UUID,
  role_name TEXT,
  role_description TEXT,
  facility_id UUID,
  facility_name TEXT,
  is_active BOOLEAN,
  expires_at TIMESTAMPTZ,
  assigned_by UUID,
  assigned_by_name TEXT,
  assigned_at TIMESTAMPTZ,
  metadata JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    ur.id AS assignment_id,
    r.id AS role_id,
    r.name AS role_name,
    r.description AS role_description,
    ur.facility_id,
    f.name AS facility_name,
    ur.is_active,
    ur.expires_at,
    ur.assigned_by,
    u.name AS assigned_by_name,
    ur.assigned_at,
    ur.metadata
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  LEFT JOIN public.facilities f ON f.id = ur.facility_id
  LEFT JOIN public.users u ON u.id = ur.assigned_by
  WHERE ur.user_id = p_user_id
    AND (p_include_inactive OR ur.is_active = true)
    AND (ur.expires_at IS NULL OR ur.expires_at > now())
  ORDER BY ur.assigned_at DESC;
$$;

-- Function to get audit trail for a user's role assignments
CREATE OR REPLACE FUNCTION public.get_role_assignment_audit(
  p_user_id UUID DEFAULT NULL,
  p_role_id UUID DEFAULT NULL,
  p_facility_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  audit_id UUID,
  user_id UUID,
  user_name TEXT,
  role_id UUID,
  role_name TEXT,
  facility_id UUID,
  facility_name TEXT,
  action TEXT,
  assigned_by UUID,
  assigned_by_name TEXT,
  created_at TIMESTAMPTZ,
  metadata JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    raa.id AS audit_id,
    raa.user_id,
    u.name AS user_name,
    raa.role_id,
    r.name AS role_name,
    raa.facility_id,
    f.name AS facility_name,
    raa.action,
    raa.assigned_by,
    u2.name AS assigned_by_name,
    raa.created_at,
    raa.metadata
  FROM public.role_assignments_audit raa
  LEFT JOIN public.users u ON u.id = raa.user_id
  LEFT JOIN public.roles r ON r.id = raa.role_id
  LEFT JOIN public.facilities f ON f.id = raa.facility_id
  LEFT JOIN public.users u2 ON u2.id = raa.assigned_by
  WHERE (p_user_id IS NULL OR raa.user_id = p_user_id)
    AND (p_role_id IS NULL OR raa.role_id = p_role_id)
    AND (p_facility_id IS NULL OR raa.facility_id = p_facility_id)
  ORDER BY raa.created_at DESC
  LIMIT p_limit;
$$;

-- Grant execute permissions to authenticated users
GRANT EXECUTE ON FUNCTION public.assign_user_role TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_user_role TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_user_role TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_permission_to_role TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_permission_from_role TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_role_assignments TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_role_assignment_audit TO authenticated;