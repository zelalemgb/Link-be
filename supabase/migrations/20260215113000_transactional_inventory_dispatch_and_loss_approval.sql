-- P0 hardening: make issue-order dispatch and loss-adjustment approval atomic + idempotent.

CREATE OR REPLACE FUNCTION public.backend_dispatch_issue_order(
  p_actor_facility_id uuid,
  p_actor_tenant_id uuid,
  p_actor_profile_id uuid,
  p_order_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_order public.issue_orders%ROWTYPE;
  v_item record;
  v_voucher_no text;
  v_current_balance numeric := 0;
  v_issue_quantity numeric := 0;
  v_resulting_balance numeric := 0;
  v_issued_at timestamptz := now();
  v_item_count integer := 0;
BEGIN
  IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL OR p_actor_profile_id IS NULL THEN
    RAISE EXCEPTION 'Missing facility or tenant context';
  END IF;

  SELECT *
  INTO v_order
  FROM public.issue_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Issue order not found';
  END IF;

  IF v_order.facility_id IS DISTINCT FROM p_actor_facility_id
     OR v_order.tenant_id IS DISTINCT FROM p_actor_tenant_id THEN
    RAISE EXCEPTION 'Issue order is outside your tenant scope';
  END IF;

  IF v_order.status = 'issued'::public.issue_order_status_enum THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_dispatched', true,
      'voucher_no', v_order.voucher_no,
      'dispatched_item_count', 0
    );
  END IF;

  IF v_order.status <> 'draft'::public.issue_order_status_enum THEN
    RAISE EXCEPTION 'Only draft issue orders can be dispatched';
  END IF;

  v_voucher_no := COALESCE(
    v_order.voucher_no,
    'SIV-' || to_char(v_issued_at, 'YYYYMMDD') || '-' || upper(substr(v_order.id::text, 1, 8))
  );

  FOR v_item IN
    SELECT id, inventory_item_id, qty_issued, batch_no
    FROM public.issue_order_items
    WHERE order_id = p_order_id
      AND COALESCE(qty_issued, 0) > 0
    ORDER BY id
  LOOP
    v_item_count := v_item_count + 1;
    v_issue_quantity := COALESCE(v_item.qty_issued, 0);

    PERFORM pg_advisory_xact_lock(hashtext('inventory_item:' || v_item.inventory_item_id::text));

    SELECT COALESCE(cs.current_quantity, 0)
    INTO v_current_balance
    FROM public.current_stock cs
    WHERE cs.facility_id = p_actor_facility_id
      AND cs.tenant_id = p_actor_tenant_id
      AND cs.inventory_item_id = v_item.inventory_item_id
    LIMIT 1;

    IF v_current_balance < v_issue_quantity THEN
      RAISE EXCEPTION 'Insufficient stock for inventory item %', v_item.inventory_item_id;
    END IF;

    v_resulting_balance := v_current_balance - v_issue_quantity;

    INSERT INTO public.stock_movements (
      inventory_item_id,
      facility_id,
      tenant_id,
      movement_type,
      quantity,
      balance_after,
      batch_number,
      created_by,
      reference_number,
      notes
    ) VALUES (
      v_item.inventory_item_id,
      p_actor_facility_id,
      p_actor_tenant_id,
      'issue',
      v_issue_quantity,
      v_resulting_balance,
      v_item.batch_no,
      p_actor_profile_id,
      v_voucher_no,
      format('Issue order dispatch (%s)', p_order_id)
    );
  END LOOP;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'Issue order has no items to dispatch';
  END IF;

  UPDATE public.issue_orders
  SET
    status = 'issued'::public.issue_order_status_enum,
    issued_at = v_issued_at,
    issued_by = p_actor_profile_id,
    voucher_no = v_voucher_no,
    updated_at = v_issued_at
  WHERE id = p_order_id
    AND status = 'draft'::public.issue_order_status_enum;

  IF NOT FOUND THEN
    SELECT *
    INTO v_order
    FROM public.issue_orders
    WHERE id = p_order_id;

    IF v_order.status = 'issued'::public.issue_order_status_enum THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_dispatched', true,
        'voucher_no', COALESCE(v_order.voucher_no, v_voucher_no),
        'dispatched_item_count', 0
      );
    END IF;

    RAISE EXCEPTION 'Issue order cannot be dispatched from current status';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_dispatched', false,
    'voucher_no', v_voucher_no,
    'dispatched_item_count', v_item_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.backend_dispatch_issue_order(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backend_dispatch_issue_order(uuid, uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.backend_dispatch_issue_order(uuid, uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backend_dispatch_issue_order(uuid, uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.backend_approve_loss_adjustment(
  p_actor_facility_id uuid,
  p_actor_tenant_id uuid,
  p_actor_profile_id uuid,
  p_adjustment_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_adjustment public.loss_adjustments%ROWTYPE;
  v_reason text;
  v_is_subtractive boolean;
  v_quantity numeric := 0;
  v_current_balance numeric := 0;
  v_resulting_balance numeric := 0;
  v_movement_type text;
  v_approved_at timestamptz := now();
BEGIN
  IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL OR p_actor_profile_id IS NULL THEN
    RAISE EXCEPTION 'Missing facility or tenant context';
  END IF;

  SELECT *
  INTO v_adjustment
  FROM public.loss_adjustments
  WHERE id = p_adjustment_id
  FOR UPDATE;

  IF v_adjustment.id IS NULL THEN
    RAISE EXCEPTION 'Loss adjustment not found';
  END IF;

  IF v_adjustment.facility_id IS DISTINCT FROM p_actor_facility_id
     OR v_adjustment.tenant_id IS DISTINCT FROM p_actor_tenant_id THEN
    RAISE EXCEPTION 'Loss adjustment is outside your tenant scope';
  END IF;

  IF v_adjustment.status = 'approved'::public.loss_adjustment_status_enum THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_approved', true,
      'movement_type', null,
      'resulting_balance', null,
      'reason', v_adjustment.reason,
      'quantity', v_adjustment.quantity
    );
  END IF;

  IF v_adjustment.status NOT IN (
    'draft'::public.loss_adjustment_status_enum,
    'submitted'::public.loss_adjustment_status_enum
  ) THEN
    RAISE EXCEPTION 'Loss adjustment cannot be approved from current status';
  END IF;

  v_quantity := COALESCE(v_adjustment.quantity, 0);
  IF v_quantity <= 0 THEN
    RAISE EXCEPTION 'Loss adjustment quantity must be greater than zero';
  END IF;

  v_reason := lower(trim(COALESCE(v_adjustment.reason, '')));
  v_is_subtractive := v_reason IN (
    'expired',
    'damage',
    'damaged',
    'theft',
    'loss',
    'negative_adjustment',
    'stock_count_correction',
    'reconciliation',
    'other'
  );

  PERFORM pg_advisory_xact_lock(hashtext('inventory_item:' || v_adjustment.inventory_item_id::text));

  SELECT COALESCE(cs.current_quantity, 0)
  INTO v_current_balance
  FROM public.current_stock cs
  WHERE cs.facility_id = p_actor_facility_id
    AND cs.tenant_id = p_actor_tenant_id
    AND cs.inventory_item_id = v_adjustment.inventory_item_id
  LIMIT 1;

  IF v_is_subtractive AND v_current_balance < v_quantity THEN
    RAISE EXCEPTION 'Insufficient stock to approve this adjustment';
  END IF;

  v_resulting_balance := CASE
    WHEN v_is_subtractive THEN v_current_balance - v_quantity
    ELSE v_current_balance + v_quantity
  END;
  v_movement_type := CASE WHEN v_is_subtractive THEN 'loss' ELSE 'adjustment' END;

  INSERT INTO public.stock_movements (
    inventory_item_id,
    facility_id,
    tenant_id,
    movement_type,
    quantity,
    balance_after,
    batch_number,
    created_by,
    reference_number,
    notes
  ) VALUES (
    v_adjustment.inventory_item_id,
    p_actor_facility_id,
    p_actor_tenant_id,
    v_movement_type,
    v_quantity,
    v_resulting_balance,
    v_adjustment.batch_no,
    p_actor_profile_id,
    COALESCE(v_adjustment.transaction_id, 'LA-' || p_adjustment_id::text),
    format('Loss adjustment approval (%s)', p_adjustment_id)
  );

  UPDATE public.loss_adjustments
  SET
    status = 'approved'::public.loss_adjustment_status_enum,
    approved_by = p_actor_profile_id,
    approved_at = v_approved_at,
    updated_at = v_approved_at
  WHERE id = p_adjustment_id
    AND status IN (
      'draft'::public.loss_adjustment_status_enum,
      'submitted'::public.loss_adjustment_status_enum
    );

  IF NOT FOUND THEN
    SELECT *
    INTO v_adjustment
    FROM public.loss_adjustments
    WHERE id = p_adjustment_id;

    IF v_adjustment.status = 'approved'::public.loss_adjustment_status_enum THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_approved', true,
        'movement_type', null,
        'resulting_balance', null,
        'reason', v_adjustment.reason,
        'quantity', v_adjustment.quantity
      );
    END IF;

    RAISE EXCEPTION 'Loss adjustment cannot be approved from current status';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_approved', false,
    'movement_type', v_movement_type,
    'resulting_balance', v_resulting_balance,
    'reason', v_adjustment.reason,
    'quantity', v_quantity
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.backend_approve_loss_adjustment(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backend_approve_loss_adjustment(uuid, uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.backend_approve_loss_adjustment(uuid, uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.backend_approve_loss_adjustment(uuid, uuid, uuid, uuid) TO service_role;
