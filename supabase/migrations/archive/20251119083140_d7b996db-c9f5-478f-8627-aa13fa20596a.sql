-- Phase 6.2e: Update RLS policies for infrastructure tables to use RBAC (fixed)

-- ============================================================================
-- FACILITIES TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage all facilities" ON public.facilities;
DROP POLICY IF EXISTS "Admins can view all facilities" ON public.facilities;
DROP POLICY IF EXISTS "Allow public clinic code validation" ON public.facilities;
DROP POLICY IF EXISTS "Allow super admin queries" ON public.facilities;
DROP POLICY IF EXISTS "Anyone can view verified facilities" ON public.facilities;
DROP POLICY IF EXISTS "Enable facility registration for all users" ON public.facilities;
DROP POLICY IF EXISTS "Providers can update their own verified facility" ON public.facilities;
DROP POLICY IF EXISTS "Providers can view own facility" ON public.facilities;
DROP POLICY IF EXISTS "Providers can view their own facility" ON public.facilities;
DROP POLICY IF EXISTS "Public can view verified facilities" ON public.facilities;
DROP POLICY IF EXISTS "RHB can view all facilities" ON public.facilities;
DROP POLICY IF EXISTS "Super admin bypass for facilities" ON public.facilities;
DROP POLICY IF EXISTS "Super admins can manage all facilities" ON public.facilities;

-- Create new RBAC-based policies for facilities
CREATE POLICY "RBAC: Anyone can view verified facilities"
  ON public.facilities
  FOR SELECT
  USING (verified = true);

CREATE POLICY "RBAC: Allow public clinic code validation"
  ON public.facilities
  FOR SELECT
  USING (true);

CREATE POLICY "RBAC: Enable facility registration for all users"
  ON public.facilities
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "RBAC: Admins can view all facilities"
  ON public.facilities
  FOR SELECT
  USING (
    current_user_has_any_role(ARRAY['admin', 'super_admin', 'rhb'])
  );

CREATE POLICY "RBAC: Super admins can manage all facilities"
  ON public.facilities
  FOR ALL
  USING (is_super_admin());

CREATE POLICY "RBAC: Users can view their facilities"
  ON public.facilities
  FOR SELECT
  USING (
    id IN (SELECT unnest(get_user_facility_ids()))
    OR admin_user_id = auth.uid()
  );

CREATE POLICY "RBAC: Facility admins can update their facilities"
  ON public.facilities
  FOR UPDATE
  USING (
    (id IN (SELECT unnest(get_user_facility_ids())) AND current_user_has_any_role(ARRAY['admin', 'hospital_ceo', 'medical_director']))
    OR admin_user_id = auth.uid()
  );

-- ============================================================================
-- TENANTS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Super admins can view all tenants" ON public.tenants;
DROP POLICY IF EXISTS "Users can view their own tenant" ON public.tenants;

-- Create new RBAC-based policies for tenants
CREATE POLICY "RBAC: Users can view their tenant"
  ON public.tenants
  FOR SELECT
  USING (
    id = get_user_tenant_id()
    OR is_super_admin()
  );

CREATE POLICY "RBAC: Super admins can manage tenants"
  ON public.tenants
  FOR ALL
  USING (is_super_admin());

-- ============================================================================
-- USERS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own data" ON public.users;
DROP POLICY IF EXISTS "Users can update their own data" ON public.users;
DROP POLICY IF EXISTS "Super admins can view all users" ON public.users;
DROP POLICY IF EXISTS "Facility admins can view their facility users" ON public.users;
DROP POLICY IF EXISTS "Admins can manage users" ON public.users;

-- Create new RBAC-based policies for users
CREATE POLICY "RBAC: Users can view their own data"
  ON public.users
  FOR SELECT
  USING (auth_user_id = auth.uid());

CREATE POLICY "RBAC: Users can update their own data"
  ON public.users
  FOR UPDATE
  USING (auth_user_id = auth.uid());

CREATE POLICY "RBAC: Admins can view facility users"
  ON public.users
  FOR SELECT
  USING (
    current_user_has_any_role(ARRAY['admin', 'super_admin', 'hospital_ceo', 'medical_director', 'nursing_head'])
    AND (
      facility_id IN (SELECT unnest(get_user_facility_ids()))
      OR is_super_admin()
    )
  );

CREATE POLICY "RBAC: Super admins can manage all users"
  ON public.users
  FOR ALL
  USING (is_super_admin());

-- ============================================================================
-- USER_ROLES TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can view facility roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can assign roles" ON public.user_roles;
DROP POLICY IF EXISTS "Super admins can manage all roles" ON public.user_roles;

-- Create new RBAC-based policies for user_roles
CREATE POLICY "RBAC: Users can view their own roles"
  ON public.user_roles
  FOR SELECT
  USING (
    user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "RBAC: Admins can view facility roles"
  ON public.user_roles
  FOR SELECT
  USING (
    current_user_has_any_role(ARRAY['admin', 'super_admin', 'hospital_ceo', 'medical_director'])
    AND (
      facility_id IN (SELECT unnest(get_user_facility_ids()))
      OR facility_id IS NULL
      OR is_super_admin()
    )
  );

CREATE POLICY "RBAC: Admins can assign roles"
  ON public.user_roles
  FOR INSERT
  WITH CHECK (
    current_user_has_any_role(ARRAY['admin', 'super_admin', 'hospital_ceo'])
    AND (
      facility_id IN (SELECT unnest(get_user_facility_ids()))
      OR facility_id IS NULL
      OR is_super_admin()
    )
  );

CREATE POLICY "RBAC: Admins can update roles"
  ON public.user_roles
  FOR UPDATE
  USING (
    current_user_has_any_role(ARRAY['admin', 'super_admin', 'hospital_ceo'])
    AND (
      facility_id IN (SELECT unnest(get_user_facility_ids()))
      OR facility_id IS NULL
      OR is_super_admin()
    )
  );

CREATE POLICY "RBAC: Super admins can delete roles"
  ON public.user_roles
  FOR DELETE
  USING (is_super_admin());

-- ============================================================================
-- ROLES TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Anyone can view roles" ON public.roles;
DROP POLICY IF EXISTS "Super admins can manage roles" ON public.roles;

-- Create new RBAC-based policies for roles
CREATE POLICY "RBAC: Anyone can view roles"
  ON public.roles
  FOR SELECT
  USING (true);

CREATE POLICY "RBAC: Super admins can manage roles"
  ON public.roles
  FOR ALL
  USING (is_super_admin());

-- ============================================================================
-- PERMISSIONS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Anyone can view permissions" ON public.permissions;
DROP POLICY IF EXISTS "Super admins can manage permissions" ON public.permissions;

-- Create new RBAC-based policies for permissions
CREATE POLICY "RBAC: Anyone can view permissions"
  ON public.permissions
  FOR SELECT
  USING (true);

CREATE POLICY "RBAC: Super admins can manage permissions"
  ON public.permissions
  FOR ALL
  USING (is_super_admin());

-- ============================================================================
-- ROLE_PERMISSIONS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Anyone can view role permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "Super admins can manage role permissions" ON public.role_permissions;

-- Create new RBAC-based policies for role_permissions
CREATE POLICY "RBAC: Anyone can view role permissions"
  ON public.role_permissions
  FOR SELECT
  USING (true);

CREATE POLICY "RBAC: Super admins can manage role permissions"
  ON public.role_permissions
  FOR ALL
  USING (is_super_admin());

-- ============================================================================
-- STAFF_REGISTRATION_REQUESTS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can create registration requests" ON public.staff_registration_requests;
DROP POLICY IF EXISTS "Users can view their own requests" ON public.staff_registration_requests;
DROP POLICY IF EXISTS "Admins can view facility requests" ON public.staff_registration_requests;
DROP POLICY IF EXISTS "Admins can update facility requests" ON public.staff_registration_requests;

-- Create new RBAC-based policies for staff_registration_requests
CREATE POLICY "RBAC: Users can create registration requests"
  ON public.staff_registration_requests
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "RBAC: Users can view their own requests"
  ON public.staff_registration_requests
  FOR SELECT
  USING (
    email = (SELECT raw_user_meta_data->>'email' FROM auth.users WHERE id = auth.uid())
  );

CREATE POLICY "RBAC: Admins can view facility requests"
  ON public.staff_registration_requests
  FOR SELECT
  USING (
    current_user_has_any_role(ARRAY['admin', 'super_admin', 'hospital_ceo'])
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

CREATE POLICY "RBAC: Admins can update facility requests"
  ON public.staff_registration_requests
  FOR UPDATE
  USING (
    current_user_has_any_role(ARRAY['admin', 'super_admin', 'hospital_ceo'])
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

-- ============================================================================
-- AUDIT_LOG TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can view audit logs" ON public.audit_log;
DROP POLICY IF EXISTS "System can insert audit logs" ON public.audit_log;

-- Create new RBAC-based policies for audit_log
CREATE POLICY "RBAC: Admins can view audit logs"
  ON public.audit_log
  FOR SELECT
  USING (
    current_user_has_any_role(ARRAY['hospital_ceo', 'medical_director', 'super_admin'])
    AND (
      tenant_id = get_user_tenant_id()
      OR is_super_admin()
    )
  );

CREATE POLICY "RBAC: System can insert audit logs"
  ON public.audit_log
  FOR INSERT
  WITH CHECK (true);

-- ============================================================================
-- FEATURE_FLAGS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Everyone can read feature flags" ON public.feature_flags;
DROP POLICY IF EXISTS "Super admins can manage feature flags" ON public.feature_flags;

-- Create new RBAC-based policies for feature_flags
CREATE POLICY "RBAC: Everyone can read feature flags"
  ON public.feature_flags
  FOR SELECT
  USING (true);

CREATE POLICY "RBAC: Super admins can manage feature flags"
  ON public.feature_flags
  FOR ALL
  USING (is_super_admin());

-- ============================================================================
-- FEATURE_REQUESTS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can create feature requests" ON public.feature_requests;
DROP POLICY IF EXISTS "Users can view their own requests" ON public.feature_requests;
DROP POLICY IF EXISTS "Users can view all requests" ON public.feature_requests;
DROP POLICY IF EXISTS "Users can update their own requests" ON public.feature_requests;
DROP POLICY IF EXISTS "Admins can update all requests" ON public.feature_requests;

-- Create new RBAC-based policies for feature_requests
CREATE POLICY "RBAC: Users can create feature requests"
  ON public.feature_requests
  FOR INSERT
  WITH CHECK (
    user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "RBAC: Users can view all feature requests"
  ON public.feature_requests
  FOR SELECT
  USING (true);

CREATE POLICY "RBAC: Users can update their own requests"
  ON public.feature_requests
  FOR UPDATE
  USING (
    user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "RBAC: Admins can update all requests"
  ON public.feature_requests
  FOR UPDATE
  USING (
    current_user_has_any_role(ARRAY['admin', 'super_admin'])
  );

-- ============================================================================
-- BETA_REGISTRATIONS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Allow anonymous beta registration submissions" ON public.beta_registrations;
DROP POLICY IF EXISTS "Super admins can update beta registrations" ON public.beta_registrations;
DROP POLICY IF EXISTS "Super admins can view beta registrations" ON public.beta_registrations;

-- Create new RBAC-based policies for beta_registrations
CREATE POLICY "RBAC: Allow anonymous beta registration submissions"
  ON public.beta_registrations
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "RBAC: Super admins can view beta registrations"
  ON public.beta_registrations
  FOR SELECT
  USING (is_super_admin());

CREATE POLICY "RBAC: Super admins can update beta registrations"
  ON public.beta_registrations
  FOR UPDATE
  USING (is_super_admin());

CREATE POLICY "RBAC: Super admins can delete beta registrations"
  ON public.beta_registrations
  FOR DELETE
  USING (is_super_admin());