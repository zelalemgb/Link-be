-- P0 hardening: transactional + idempotent staff request approval workflow.

CREATE OR REPLACE FUNCTION public.backend_approve_staff_registration_request(
  p_actor_role text,
  p_actor_facility_id uuid,
  p_actor_tenant_id uuid,
  p_actor_profile_id uuid,
  p_request_id uuid,
  p_reason text DEFAULT NULL,
  p_actor_ip_address text DEFAULT NULL,
  p_actor_user_agent text DEFAULT NULL,
  p_request_trace_id uuid DEFAULT NULL,
  p_debug_fail_after_role_upsert boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor_role text;
  v_request public.staff_registration_requests%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_role_id uuid;
  v_approved_role_name text;
  v_reviewed_at timestamptz := now();
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
BEGIN
  v_actor_role := lower(trim(COALESCE(p_actor_role, '')));
  IF v_actor_role = ''
     OR v_actor_role NOT IN ('clinic_admin', 'admin', 'super_admin', 'hospital_ceo', 'medical_director', 'nursing_head') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT *
  INTO v_request
  FROM public.staff_registration_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_actor_role <> 'super_admin' THEN
    IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Missing facility or tenant context';
    END IF;

    IF v_request.facility_id IS DISTINCT FROM p_actor_facility_id
       OR v_request.tenant_id IS DISTINCT FROM p_actor_tenant_id THEN
      RAISE EXCEPTION 'Cannot manage requests outside your facility';
    END IF;
  END IF;

  IF lower(trim(COALESCE(v_request.status, ''))) <> 'pending' THEN
    RAISE EXCEPTION 'Only pending requests can be approved';
  END IF;

  SELECT r.id, r.name
  INTO v_role_id, v_approved_role_name
  FROM public.roles r
  WHERE lower(r.name) = lower(trim(COALESCE(v_request.requested_role, '')))
     OR lower(r.slug) = lower(trim(COALESCE(v_request.requested_role, '')))
  ORDER BY CASE WHEN lower(r.name) = lower(trim(COALESCE(v_request.requested_role, ''))) THEN 0 ELSE 1 END
  LIMIT 1;

  IF v_role_id IS NULL OR v_approved_role_name IS NULL THEN
    RAISE EXCEPTION 'Requested role is not assignable';
  END IF;

  IF lower(trim(v_approved_role_name)) = 'super_admin' THEN
    RAISE EXCEPTION 'Cannot assign super_admin role';
  END IF;

  SELECT *
  INTO v_user
  FROM public.users
  WHERE auth_user_id = v_request.auth_user_id
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_user.id IS NULL THEN
    INSERT INTO public.users (
      auth_user_id,
      name,
      full_name,
      facility_id,
      tenant_id,
      user_role,
      is_active,
      email_verified
    ) VALUES (
      v_request.auth_user_id,
      v_request.name,
      v_request.name,
      v_request.facility_id,
      v_request.tenant_id,
      v_approved_role_name,
      true,
      true
    )
    RETURNING * INTO v_user;
  END IF;

  UPDATE public.users
  SET facility_id = v_request.facility_id,
      tenant_id = v_request.tenant_id,
      email_verified = true,
      is_active = true,
      user_role = v_approved_role_name,
      updated_at = now()
  WHERE id = v_user.id;

  INSERT INTO public.user_roles (
    user_id,
    role_id,
    facility_id,
    tenant_id,
    assigned_by,
    assigned_at,
    is_active
  ) VALUES (
    v_user.id,
    v_role_id,
    v_request.facility_id,
    v_request.tenant_id,
    p_actor_profile_id,
    now(),
    true
  )
  ON CONFLICT (user_id, role_id, facility_id) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id,
        assigned_by = EXCLUDED.assigned_by,
        assigned_at = now(),
        is_active = true;

  IF p_debug_fail_after_role_upsert THEN
    RAISE EXCEPTION 'DEBUG_APPROVAL_FAILURE_AFTER_ROLE_UPSERT';
  END IF;

  UPDATE public.staff_registration_requests
  SET status = 'approved',
      reviewed_at = v_reviewed_at,
      reviewed_by = p_actor_profile_id,
      rejection_reason = NULL,
      updated_at = v_reviewed_at
  WHERE id = v_request.id
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only pending requests can be approved';
  END IF;

  BEGIN
    INSERT INTO public.audit_log (
      action,
      event_type,
      entity_type,
      tenant_id,
      facility_id,
      actor_user_id,
      actor_role,
      actor_ip_address,
      actor_user_agent,
      entity_id,
      action_category,
      metadata,
      request_id
    ) VALUES (
      'approve_staff_registration_request',
      'update',
      'staff_registration_request',
      v_request.tenant_id,
      v_request.facility_id,
      p_actor_profile_id,
      p_actor_role,
      CASE
        WHEN p_actor_ip_address IS NULL OR btrim(p_actor_ip_address) = '' THEN NULL
        WHEN p_actor_ip_address ~ '^[0-9A-Fa-f:.]+$' THEN p_actor_ip_address::inet
        ELSE NULL
      END,
      p_actor_user_agent,
      v_request.id,
      'authorization',
      jsonb_build_object(
        'approvedRole', v_approved_role_name,
        'reason', v_reason,
        'approvalFlow', 'backend_approve_staff_registration_request'
      ),
      p_request_trace_id
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'AUDIT_DURABILITY_FAILURE';
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.backend_approve_staff_registration_request(text, uuid, uuid, uuid, uuid, text, text, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backend_approve_staff_registration_request(text, uuid, uuid, uuid, uuid, text, text, text, uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.backend_approve_staff_registration_request(text, uuid, uuid, uuid, uuid, text, text, text, uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backend_approve_staff_registration_request(text, uuid, uuid, uuid, uuid, text, text, text, uuid, boolean) TO service_role;
