-- Backfill missing public.users records and RBAC role assignment for existing Super Admin auth users
-- Criteria: auth.users.raw_user_meta_data.role/user_role = 'super_admin'
-- This fixes cases where Super Admin accounts were created before the auth->public.users trigger existed.

DO $$
DECLARE
  v_super_admin_role_id uuid;
BEGIN
  SELECT id INTO v_super_admin_role_id
  FROM public.roles
  WHERE slug = 'super-admin'
  LIMIT 1;

  IF v_super_admin_role_id IS NULL THEN
    RAISE EXCEPTION 'RBAC role not found: roles.slug = super-admin';
  END IF;

  -- 1) Insert missing public.users rows for super admin auth users
  WITH super_admin_auth AS (
    SELECT
      au.id AS auth_user_id,
      COALESCE(
        au.raw_user_meta_data ->> 'full_name',
        au.raw_user_meta_data ->> 'name',
        split_part(COALESCE(au.email, ''), '@', 1),
        'Super Admin'
      ) AS full_name,
      NULLIF(au.raw_user_meta_data ->> 'facility_id', '')::uuid AS facility_id
    FROM auth.users au
    WHERE (au.raw_user_meta_data ->> 'user_role' = 'super_admin'
        OR au.raw_user_meta_data ->> 'role' = 'super_admin')
  ), resolved AS (
    SELECT
      sa.auth_user_id,
      sa.full_name,
      sa.facility_id,
      f.tenant_id
    FROM super_admin_auth sa
    LEFT JOIN public.facilities f ON f.id = sa.facility_id
  )
  INSERT INTO public.users (
    auth_user_id,
    name,
    full_name,
    role,
    user_role,
    facility_id,
    tenant_id,
    verified,
    email_verified,
    created_at,
    updated_at
  )
  SELECT
    r.auth_user_id,
    r.full_name,
    r.full_name,
    'admin'::public.app_role,
    'super_admin'::public.user_role,
    r.facility_id,
    r.tenant_id,
    true,
    true,
    now(),
    now()
  FROM resolved r
  WHERE r.tenant_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = r.auth_user_id
    );

  -- 2) Ensure RBAC super-admin role assignment exists (system-scope, facility_id NULL)
  WITH target_users AS (
    SELECT u.id AS user_id, u.tenant_id
    FROM public.users u
    JOIN auth.users au ON au.id = u.auth_user_id
    WHERE (au.raw_user_meta_data ->> 'user_role' = 'super_admin'
        OR au.raw_user_meta_data ->> 'role' = 'super_admin')
  )
  INSERT INTO public.user_roles (
    user_id,
    role_id,
    facility_id,
    tenant_id,
    is_active,
    assigned_at,
    assigned_by,
    expires_at,
    metadata
  )
  SELECT
    tu.user_id,
    v_super_admin_role_id,
    NULL,
    tu.tenant_id,
    true,
    now(),
    NULL,
    NULL,
    jsonb_build_object('source', 'backfill_super_admin_from_auth_metadata')
  FROM target_users tu
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = tu.user_id
      AND ur.role_id = v_super_admin_role_id
      AND ur.is_active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
  );

END $$;
