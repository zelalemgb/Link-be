-- Transactional backend RPC helpers for staff role updates and inventory workflows.

CREATE OR REPLACE FUNCTION public.backend_update_staff_roles(
  p_actor_role text,
  p_actor_facility_id uuid,
  p_actor_tenant_id uuid,
  p_actor_profile_id uuid,
  p_target_user_id uuid,
  p_roles text[],
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor_role text;
  v_target public.users%ROWTYPE;
  v_old_roles text[] := '{}'::text[];
  v_new_roles text[] := '{}'::text[];
  v_role_name text;
  v_role_id uuid;
BEGIN
  v_actor_role := lower(trim(COALESCE(p_actor_role, '')));
  IF v_actor_role = '' THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF COALESCE(array_length(p_roles, 1), 0) = 0 THEN
    RAISE EXCEPTION 'At least one role is required';
  END IF;
  IF v_actor_role NOT IN ('clinic_admin', 'admin', 'hospital_ceo', 'medical_director', 'nursing_head', 'super_admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT *
  INTO v_target
  FROM public.users
  WHERE id = p_target_user_id
  LIMIT 1;

  IF v_target.id IS NULL THEN
    RAISE EXCEPTION 'Target user not found';
  END IF;

  IF v_actor_role <> 'super_admin' THEN
    IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL THEN
      RAISE EXCEPTION 'Missing facility or tenant context';
    END IF;
    IF v_target.facility_id IS DISTINCT FROM p_actor_facility_id OR v_target.tenant_id IS DISTINCT FROM p_actor_tenant_id THEN
      RAISE EXCEPTION 'Cannot manage users outside your facility';
    END IF;
  END IF;

  FOREACH v_role_name IN ARRAY p_roles LOOP
    v_role_name := lower(trim(COALESCE(v_role_name, '')));
    IF v_role_name = '' THEN
      CONTINUE;
    END IF;
    IF v_role_name = 'super_admin' THEN
      RAISE EXCEPTION 'Cannot assign super_admin role';
    END IF;

    SELECT id
    INTO v_role_id
    FROM public.roles
    WHERE name = v_role_name
    LIMIT 1;

    IF v_role_id IS NULL THEN
      RAISE EXCEPTION 'Requested role is not assignable: %', v_role_name;
    END IF;

    IF array_position(v_new_roles, v_role_name) IS NULL THEN
      v_new_roles := array_append(v_new_roles, v_role_name);
    END IF;
  END LOOP;

  IF COALESCE(array_length(v_new_roles, 1), 0) = 0 THEN
    RAISE EXCEPTION 'No valid assignable roles provided';
  END IF;

  SELECT COALESCE(array_agg(r.name ORDER BY r.name), '{}'::text[])
  INTO v_old_roles
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_target_user_id;

  DELETE FROM public.user_roles
  WHERE user_id = p_target_user_id;

  FOREACH v_role_name IN ARRAY v_new_roles LOOP
    SELECT id
    INTO v_role_id
    FROM public.roles
    WHERE name = v_role_name
    LIMIT 1;

    INSERT INTO public.user_roles (
      user_id,
      role_id,
      facility_id,
      tenant_id,
      assigned_by,
      is_active
    ) VALUES (
      p_target_user_id,
      v_role_id,
      v_target.facility_id,
      v_target.tenant_id,
      p_actor_profile_id,
      true
    )
    ON CONFLICT (user_id, role_id, facility_id) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id,
          assigned_by = EXCLUDED.assigned_by,
          assigned_at = now(),
          is_active = true;
  END LOOP;

  UPDATE public.users
  SET user_role = v_new_roles[1]::public.user_role,
      updated_at = now()
  WHERE id = p_target_user_id;

  INSERT INTO public.user_role_changes (
    user_id,
    facility_id,
    tenant_id,
    old_roles,
    new_roles,
    changed_by,
    reason,
    created_at
  ) VALUES (
    p_target_user_id,
    v_target.facility_id,
    v_target.tenant_id,
    v_old_roles,
    v_new_roles,
    p_actor_profile_id,
    COALESCE(p_reason, 'updated by clinic admin UI'),
    now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.backend_update_staff_roles(text, uuid, uuid, uuid, uuid, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backend_update_staff_roles(text, uuid, uuid, uuid, uuid, text[], text) FROM anon;
REVOKE ALL ON FUNCTION public.backend_update_staff_roles(text, uuid, uuid, uuid, uuid, text[], text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backend_update_staff_roles(text, uuid, uuid, uuid, uuid, text[], text) TO service_role;

CREATE OR REPLACE FUNCTION public.backend_submit_resupply_request(
  p_actor_facility_id uuid,
  p_actor_tenant_id uuid,
  p_actor_profile_id uuid,
  p_request_id uuid DEFAULT NULL,
  p_request_details jsonb DEFAULT '{}'::jsonb,
  p_lines jsonb DEFAULT '[]'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_request_id uuid;
  v_reporting_period text;
  v_account_type text;
  v_request_type text;
  v_request_to text;
  v_notes text;
  v_reference_no text;
BEGIN
  IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL OR p_actor_profile_id IS NULL THEN
    RAISE EXCEPTION 'Missing facility or tenant context';
  END IF;

  IF COALESCE(jsonb_typeof(p_lines), '') <> 'array' OR COALESCE(jsonb_array_length(p_lines), 0) = 0 THEN
    RAISE EXCEPTION 'At least one line item is required';
  END IF;

  v_reporting_period := NULLIF(trim(COALESCE(p_request_details ->> 'reporting_period', '')), '');
  v_account_type := NULLIF(trim(COALESCE(p_request_details ->> 'account_type', '')), '');
  v_request_type := NULLIF(trim(COALESCE(p_request_details ->> 'request_type', '')), '');
  v_request_to := NULLIF(trim(COALESCE(p_request_details ->> 'request_to', '')), '');
  v_notes := NULLIF(trim(COALESCE(p_request_details ->> 'notes', '')), '');

  IF v_reporting_period IS NULL OR v_account_type IS NULL OR v_request_type IS NULL OR v_request_to IS NULL THEN
    RAISE EXCEPTION 'Invalid request details';
  END IF;

  IF p_request_id IS NOT NULL THEN
    SELECT id
    INTO v_request_id
    FROM public.request_for_resupply
    WHERE id = p_request_id
      AND facility_id = p_actor_facility_id
      AND tenant_id = p_actor_tenant_id
    FOR UPDATE;

    IF v_request_id IS NULL THEN
      RAISE EXCEPTION 'Request not found';
    END IF;

    UPDATE public.request_for_resupply
    SET reporting_period = v_reporting_period,
        account_type = v_account_type,
        request_type = v_request_type,
        request_to = v_request_to,
        notes = v_notes,
        status = 'submitted',
        submitted_at = now(),
        updated_at = now()
    WHERE id = v_request_id;
  ELSE
    v_reference_no := 'RRF-' || to_char(now(), 'YYMMDDHH24MISS') || floor(random() * 10)::int::text;
    INSERT INTO public.request_for_resupply (
      reference_no,
      facility_id,
      tenant_id,
      reporting_period,
      account_type,
      request_type,
      request_to,
      generated_by,
      status,
      submitted_at,
      notes
    ) VALUES (
      v_reference_no,
      p_actor_facility_id,
      p_actor_tenant_id,
      v_reporting_period,
      v_account_type,
      v_request_type,
      v_request_to,
      p_actor_profile_id,
      'submitted',
      now(),
      v_notes
    )
    RETURNING id INTO v_request_id;
  END IF;

  DELETE FROM public.request_line_items
  WHERE request_id = v_request_id;

  INSERT INTO public.request_line_items (
    request_id,
    inventory_item_id,
    tenant_id,
    quantity_requested,
    amc,
    soh,
    max_stock,
    unit_cost,
    total_cost
  )
  SELECT
    v_request_id,
    line.inventory_item_id,
    p_actor_tenant_id,
    GREATEST(COALESCE(line.quantity_requested, 0)::integer, 1),
    GREATEST(COALESCE(line.amc, 0)::integer, 0),
    GREATEST(COALESCE(line.soh, 0)::integer, 0),
    0,
    GREATEST(COALESCE(line.unit_cost, 0), 0),
    GREATEST(COALESCE(line.unit_cost, 0), 0) * GREATEST(COALESCE(line.quantity_requested, 0)::integer, 1)
  FROM jsonb_to_recordset(p_lines) AS line(
    inventory_item_id uuid,
    quantity_requested numeric,
    amc numeric,
    soh numeric,
    unit_cost numeric
  );

  RETURN v_request_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.backend_submit_resupply_request(uuid, uuid, uuid, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backend_submit_resupply_request(uuid, uuid, uuid, uuid, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.backend_submit_resupply_request(uuid, uuid, uuid, uuid, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backend_submit_resupply_request(uuid, uuid, uuid, uuid, jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.backend_create_receiving_from_request(
  p_actor_facility_id uuid,
  p_actor_tenant_id uuid,
  p_actor_profile_id uuid,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_request public.request_for_resupply%ROWTYPE;
  v_invoice_id uuid;
  v_invoice_no text;
  v_created boolean := false;
  v_repopulated boolean := false;
  v_item_count integer := 0;
BEGIN
  IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL OR p_actor_profile_id IS NULL THEN
    RAISE EXCEPTION 'Missing facility or tenant context';
  END IF;

  SELECT *
  INTO v_request
  FROM public.request_for_resupply
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF v_request.facility_id IS DISTINCT FROM p_actor_facility_id OR v_request.tenant_id IS DISTINCT FROM p_actor_tenant_id THEN
    RAISE EXCEPTION 'Cannot receive requests outside your facility';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.request_line_items
    WHERE request_id = p_request_id
  ) THEN
    RAISE EXCEPTION 'Request has no line items';
  END IF;

  v_invoice_no := 'INV-' || v_request.reference_no;
  SELECT id
  INTO v_invoice_id
  FROM public.receiving_invoices
  WHERE facility_id = p_actor_facility_id
    AND invoice_no = v_invoice_no
  LIMIT 1
  FOR UPDATE;

  IF v_invoice_id IS NULL THEN
    INSERT INTO public.receiving_invoices (
      invoice_no,
      receive_date,
      receive_type,
      supplier_id,
      delivery_note_no,
      goods_receiving_note_no,
      notes,
      facility_id,
      created_by,
      status,
      tenant_id,
      request_id
    ) VALUES (
      v_invoice_no,
      CURRENT_DATE,
      'transfer',
      NULL,
      '',
      '',
      'Received from Request ' || v_request.reference_no,
      p_actor_facility_id,
      p_actor_profile_id,
      'draft',
      p_actor_tenant_id,
      v_request.id
    )
    RETURNING id INTO v_invoice_id;
    v_created := true;
  END IF;

  IF v_created THEN
    INSERT INTO public.receiving_invoice_items (
      invoice_id,
      inventory_item_id,
      batch_no,
      quantity,
      unit_cost,
      unit_selling_price,
      profit_margin,
      tenant_id,
      requested_quantity
    )
    SELECT
      v_invoice_id,
      rli.inventory_item_id,
      'BATCH-XXX',
      GREATEST(COALESCE(rli.quantity_requested, 0) - COALESCE(hist.already_received, 0), 0),
      GREATEST(COALESCE(rli.unit_cost, 0), 0),
      GREATEST(COALESCE(rli.unit_cost, 0), 0) * 1.2,
      20,
      p_actor_tenant_id,
      GREATEST(COALESCE(rli.quantity_requested, 0), 0)
    FROM public.request_line_items rli
    LEFT JOIN (
      SELECT rii.inventory_item_id, SUM(COALESCE(rii.quantity, 0))::integer AS already_received
      FROM public.receiving_invoice_items rii
      JOIN public.receiving_invoices ri ON ri.id = rii.invoice_id
      WHERE ri.request_id = p_request_id
        AND ri.status = 'submitted'
      GROUP BY rii.inventory_item_id
    ) AS hist ON hist.inventory_item_id = rli.inventory_item_id
    WHERE rli.request_id = p_request_id
      AND GREATEST(COALESCE(rli.quantity_requested, 0) - COALESCE(hist.already_received, 0), 0) > 0;
  END IF;

  SELECT COUNT(*)
  INTO v_item_count
  FROM public.receiving_invoice_items
  WHERE invoice_id = v_invoice_id;

  IF v_item_count = 0 THEN
    INSERT INTO public.receiving_invoice_items (
      invoice_id,
      inventory_item_id,
      batch_no,
      quantity,
      unit_cost,
      unit_selling_price,
      profit_margin,
      tenant_id,
      requested_quantity
    )
    SELECT
      v_invoice_id,
      rli.inventory_item_id,
      'BATCH-XXX',
      GREATEST(COALESCE(rli.quantity_requested, 0), 0),
      GREATEST(COALESCE(rli.unit_cost, 0), 0),
      GREATEST(COALESCE(rli.unit_cost, 0), 0) * 1.2,
      20,
      p_actor_tenant_id,
      GREATEST(COALESCE(rli.quantity_requested, 0), 0)
    FROM public.request_line_items rli
    WHERE rli.request_id = p_request_id
      AND GREATEST(COALESCE(rli.quantity_requested, 0), 0) > 0;
    v_repopulated := true;
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', v_invoice_id,
    'created', v_created,
    'repopulated', v_repopulated
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.backend_create_receiving_from_request(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backend_create_receiving_from_request(uuid, uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.backend_create_receiving_from_request(uuid, uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backend_create_receiving_from_request(uuid, uuid, uuid, uuid) TO service_role;
