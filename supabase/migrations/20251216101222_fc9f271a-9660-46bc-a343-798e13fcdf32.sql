
-- Fix: Create public.users record for super admin with System Administration tenant
-- Super admins operate at system scope per architecture/rbac-super-admin-system-scope

DO $$
DECLARE
  v_super_admin_role_id uuid;
  v_system_tenant_id uuid := '266f245d-b5a0-4db9-8787-57156f0f884e'; -- System Administration tenant
  v_new_user_id uuid;
BEGIN
  -- Get super-admin role
  SELECT id INTO v_super_admin_role_id
  FROM public.roles
  WHERE slug = 'super-admin'
  LIMIT 1;

  IF v_super_admin_role_id IS NULL THEN
    RAISE EXCEPTION 'RBAC role not found: roles.slug = super-admin';
  END IF;

  -- Create public.users record for super admin auth user
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
    au.id,
    COALESCE(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', split_part(COALESCE(au.email, ''), '@', 1), 'Super Admin'),
    COALESCE(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', split_part(COALESCE(au.email, ''), '@', 1), 'Super Admin'),
    'admin'::public.app_role,
    'super_admin'::public.user_role,
    NULL, -- Super admins have no facility_id (system scope)
    v_system_tenant_id, -- System Administration tenant
    true,
    true,
    now(),
    now()
  FROM auth.users au
  WHERE au.id = 'd0fa4ee5-b4c9-403a-a6c7-35fcfb30fc2b'
    AND NOT EXISTS (
      SELECT 1 FROM public.users u WHERE u.auth_user_id = au.id
    )
  RETURNING id INTO v_new_user_id;

  -- If user was created or already exists, ensure RBAC role assignment
  IF v_new_user_id IS NULL THEN
    SELECT id INTO v_new_user_id FROM public.users WHERE auth_user_id = 'd0fa4ee5-b4c9-403a-a6c7-35fcfb30fc2b';
  END IF;

  IF v_new_user_id IS NOT NULL THEN
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
      v_new_user_id,
      v_super_admin_role_id,
      NULL, -- System scope
      v_system_tenant_id,
      true,
      now(),
      NULL,
      NULL,
      jsonb_build_object('source', 'backfill_super_admin')
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_new_user_id
        AND ur.role_id = v_super_admin_role_id
        AND ur.is_active = true
    );
  END IF;
END $$;
