-- Harden super-admin privilege helpers and admin role management RPCs.

CREATE OR REPLACE FUNCTION public.promote_to_super_admin(user_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor_auth_user_id uuid;
  v_actor_profile public.users%ROWTYPE;
  v_target_auth_user_id uuid;
BEGIN
  v_actor_auth_user_id := auth.uid();
  IF v_actor_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT *
  INTO v_actor_profile
  FROM public.users
  WHERE auth_user_id = v_actor_auth_user_id
  LIMIT 1;

  IF v_actor_profile.id IS NULL OR v_actor_profile.user_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT auth_user_id
  INTO v_target_auth_user_id
  FROM public.users
  WHERE phone_number = user_phone
  LIMIT 1;

  IF v_target_auth_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found with phone: ' || user_phone);
  END IF;

  UPDATE public.users
  SET user_role = 'super_admin',
      updated_at = now()
  WHERE auth_user_id = v_target_auth_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'User promoted to super admin successfully',
    'user_id', v_target_auth_user_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.promote_to_super_admin(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_to_super_admin(text) FROM anon;
REVOKE ALL ON FUNCTION public.promote_to_super_admin(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_to_super_admin(text) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_update_roles(
  p_user_id uuid,
  p_roles text[],
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_old_roles text[] := '{}'::text[];
  v_new_roles text[] := '{}'::text[];
  v_target_role public.user_role;
  v_facility uuid;
  v_tenant uuid;
  v_changed_by uuid;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF COALESCE(array_length(p_roles, 1), 0) = 0 THEN
    RAISE EXCEPTION 'At least one role is required';
  END IF;

  IF array_position(p_roles, 'super_admin') IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot assign super_admin role';
  END IF;

  SELECT user_role, facility_id, tenant_id
  INTO v_target_role, v_facility, v_tenant
  FROM public.users
  WHERE id = p_user_id;

  IF v_facility IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  SELECT COALESCE(array_agg(r.name ORDER BY r.name), '{}'::text[])
  INTO v_old_roles
  FROM public.user_roles ur
  JOIN public.roles r ON ur.role_id = r.id
  WHERE ur.user_id = p_user_id;

  DELETE FROM public.user_roles
  WHERE user_id = p_user_id;

  INSERT INTO public.user_roles(user_id, role_id)
  SELECT p_user_id, r.id
  FROM public.roles r
  WHERE r.name = ANY(p_roles)
    AND r.name <> 'super_admin';

  SELECT COALESCE(array_agg(r.name ORDER BY r.name), '{}'::text[])
  INTO v_new_roles
  FROM public.user_roles ur
  JOIN public.roles r ON ur.role_id = r.id
  WHERE ur.user_id = p_user_id;

  IF COALESCE(array_length(v_new_roles, 1), 0) = 0 THEN
    RAISE EXCEPTION 'No valid assignable roles provided';
  END IF;

  SELECT id
  INTO v_changed_by
  FROM public.users
  WHERE auth_user_id = auth.uid()
  LIMIT 1;

  UPDATE public.users
  SET user_role = COALESCE(v_new_roles[1], v_target_role::text)::public.user_role,
      updated_at = now()
  WHERE id = p_user_id;

  INSERT INTO public.user_role_changes(
    user_id, facility_id, tenant_id, old_roles, new_roles, changed_by, reason, created_at
  ) VALUES (
    p_user_id, v_facility, v_tenant, v_old_roles, v_new_roles, v_changed_by, p_reason, now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_roles(uuid, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_roles(uuid, text[], text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_update_roles(uuid, text[], text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_roles(uuid, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_roles(uuid, text[], text) TO service_role;
