BEGIN;

CREATE OR REPLACE FUNCTION public.inventory_movement_delta(
  p_movement_type text,
  p_quantity integer
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_movement_type IN ('receipt', 'return', 'transfer_in', 'adjustment') THEN COALESCE(p_quantity, 0)
    WHEN p_movement_type IN ('issue', 'out', 'transfer_out', 'expired', 'damaged', 'loss') THEN -COALESCE(p_quantity, 0)
    ELSE 0
  END;
$$;

DROP VIEW IF EXISTS public.current_stock;

CREATE OR REPLACE VIEW public.current_stock
WITH (security_invoker = true)
AS
SELECT
  i.id AS inventory_item_id,
  i.tenant_id,
  i.name,
  i.generic_name,
  i.dosage_form,
  i.strength,
  i.unit_of_measure,
  i.reorder_level,
  i.facility_id,
  COALESCE((
    SELECT SUM(public.inventory_movement_delta(sm.movement_type, sm.quantity))
    FROM public.stock_movements sm
    WHERE sm.inventory_item_id = i.id
      AND sm.facility_id = i.facility_id
      AND COALESCE(sm.tenant_id, i.tenant_id) = i.tenant_id
  ), 0) AS current_quantity,
  (
    SELECT MAX(sm.created_at)
    FROM public.stock_movements sm
    WHERE sm.inventory_item_id = i.id
      AND sm.facility_id = i.facility_id
      AND COALESCE(sm.tenant_id, i.tenant_id) = i.tenant_id
  ) AS last_movement_date
FROM public.inventory_items i
WHERE i.is_active = true;

CREATE TABLE IF NOT EXISTS public.physical_inventory_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id text NOT NULL UNIQUE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
  account_type text NOT NULL,
  period_type text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  is_locked boolean NOT NULL DEFAULT true,
  notes text,
  created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  committed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ended_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  committed_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT physical_inventory_sessions_status_check
    CHECK (status IN ('draft', 'committed', 'closed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS public.physical_inventory_session_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.physical_inventory_sessions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  batch_no text,
  manufacturer text,
  expiry_date date,
  qty_sound integer NOT NULL DEFAULT 0,
  qty_damaged integer NOT NULL DEFAULT 0,
  qty_expired integer NOT NULL DEFAULT 0,
  system_qty integer NOT NULL DEFAULT 0,
  new_unit_cost numeric(10, 2),
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT physical_inventory_session_items_qty_sound_non_negative CHECK (qty_sound >= 0),
  CONSTRAINT physical_inventory_session_items_qty_damaged_non_negative CHECK (qty_damaged >= 0),
  CONSTRAINT physical_inventory_session_items_qty_expired_non_negative CHECK (qty_expired >= 0),
  CONSTRAINT physical_inventory_session_items_system_qty_non_negative CHECK (system_qty >= 0),
  CONSTRAINT physical_inventory_session_items_unit_cost_non_negative CHECK (new_unit_cost IS NULL OR new_unit_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_physical_inventory_sessions_scope
  ON public.physical_inventory_sessions(tenant_id, facility_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_physical_inventory_items_session
  ON public.physical_inventory_session_items(session_id, inventory_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_physical_inventory_locked_session
  ON public.physical_inventory_sessions(tenant_id, facility_id)
  WHERE is_locked = true;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_physical_inventory_item_batch
  ON public.physical_inventory_session_items(session_id, inventory_item_id, COALESCE(batch_no, ''));

ALTER TABLE public.physical_inventory_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.physical_inventory_session_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Facility staff can view physical inventory sessions" ON public.physical_inventory_sessions;
CREATE POLICY "Facility staff can view physical inventory sessions"
  ON public.physical_inventory_sessions FOR SELECT
  USING (
    facility_id IN (
      SELECT facility_id
      FROM public.users
      WHERE auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Logistic officers can manage physical inventory sessions" ON public.physical_inventory_sessions;
CREATE POLICY "Logistic officers can manage physical inventory sessions"
  ON public.physical_inventory_sessions FOR ALL
  USING (
    facility_id IN (
      SELECT facility_id
      FROM public.users
      WHERE auth_user_id = auth.uid()
        AND user_role = ANY(ARRAY[
          'logistic_officer'::public.user_role,
          'pharmacist'::public.user_role,
          'admin'::public.user_role,
          'clinic_admin'::public.user_role,
          'super_admin'::public.user_role
        ])
    )
  )
  WITH CHECK (
    facility_id IN (
      SELECT facility_id
      FROM public.users
      WHERE auth_user_id = auth.uid()
        AND user_role = ANY(ARRAY[
          'logistic_officer'::public.user_role,
          'pharmacist'::public.user_role,
          'admin'::public.user_role,
          'clinic_admin'::public.user_role,
          'super_admin'::public.user_role
        ])
    )
  );

DROP POLICY IF EXISTS "Facility staff can view physical inventory items" ON public.physical_inventory_session_items;
CREATE POLICY "Facility staff can view physical inventory items"
  ON public.physical_inventory_session_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.physical_inventory_sessions pis
      JOIN public.users u
        ON u.facility_id = pis.facility_id
      WHERE pis.id = physical_inventory_session_items.session_id
        AND u.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Logistic officers can manage physical inventory items" ON public.physical_inventory_session_items;
CREATE POLICY "Logistic officers can manage physical inventory items"
  ON public.physical_inventory_session_items FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.physical_inventory_sessions pis
      JOIN public.users u
        ON u.facility_id = pis.facility_id
      WHERE pis.id = physical_inventory_session_items.session_id
        AND u.auth_user_id = auth.uid()
        AND u.user_role = ANY(ARRAY[
          'logistic_officer'::public.user_role,
          'pharmacist'::public.user_role,
          'admin'::public.user_role,
          'clinic_admin'::public.user_role,
          'super_admin'::public.user_role
        ])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.physical_inventory_sessions pis
      JOIN public.users u
        ON u.facility_id = pis.facility_id
      WHERE pis.id = physical_inventory_session_items.session_id
        AND u.auth_user_id = auth.uid()
        AND u.user_role = ANY(ARRAY[
          'logistic_officer'::public.user_role,
          'pharmacist'::public.user_role,
          'admin'::public.user_role,
          'clinic_admin'::public.user_role,
          'super_admin'::public.user_role
        ])
    )
  );

DROP TRIGGER IF EXISTS update_physical_inventory_sessions_updated_at ON public.physical_inventory_sessions;
CREATE TRIGGER update_physical_inventory_sessions_updated_at
  BEFORE UPDATE ON public.physical_inventory_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_physical_inventory_session_items_updated_at ON public.physical_inventory_session_items;
CREATE TRIGGER update_physical_inventory_session_items_updated_at
  BEFORE UPDATE ON public.physical_inventory_session_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.backend_create_stock_movement(
  p_actor_facility_id UUID,
  p_actor_tenant_id UUID,
  p_actor_profile_id UUID,
  p_inventory_item_id UUID,
  p_movement_type text,
  p_quantity integer,
  p_batch_number text DEFAULT NULL,
  p_expiry_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_unit_cost numeric DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_adjustment_direction text DEFAULT NULL
)
RETURNS public.stock_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory_items%ROWTYPE;
  v_effective_movement_type text;
  v_delta integer;
  v_current_balance integer := 0;
  v_new_balance integer := 0;
  v_inserted public.stock_movements%ROWTYPE;
BEGIN
  IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL OR p_actor_profile_id IS NULL THEN
    RAISE EXCEPTION 'Missing facility or tenant context';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;

  SELECT *
  INTO v_item
  FROM public.inventory_items
  WHERE id = p_inventory_item_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory item not found';
  END IF;

  IF v_item.facility_id <> p_actor_facility_id OR v_item.tenant_id <> p_actor_tenant_id THEN
    RAISE EXCEPTION 'Inventory item is outside your facility';
  END IF;

  v_effective_movement_type := lower(trim(COALESCE(p_movement_type, '')));
  IF v_effective_movement_type NOT IN ('receipt', 'issue', 'adjustment', 'loss', 'return') THEN
    RAISE EXCEPTION 'Unsupported movement type';
  END IF;

  IF v_effective_movement_type = 'adjustment' THEN
    IF p_adjustment_direction IS NULL OR lower(trim(p_adjustment_direction)) IN ('increase', 'in') THEN
      v_effective_movement_type := 'adjustment';
    ELSIF lower(trim(p_adjustment_direction)) IN ('decrease', 'out') THEN
      v_effective_movement_type := 'loss';
    ELSE
      RAISE EXCEPTION 'Adjustment direction must be increase or decrease';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('inventory_item:' || p_inventory_item_id::text));

  SELECT COALESCE(cs.current_quantity, 0)
  INTO v_current_balance
  FROM public.current_stock cs
  WHERE cs.inventory_item_id = p_inventory_item_id
    AND cs.facility_id = p_actor_facility_id
    AND cs.tenant_id = p_actor_tenant_id
  LIMIT 1;

  v_delta := public.inventory_movement_delta(v_effective_movement_type, p_quantity);
  v_new_balance := v_current_balance + v_delta;

  IF v_new_balance < 0 THEN
    RAISE EXCEPTION 'Insufficient stock for inventory item %', p_inventory_item_id;
  END IF;

  INSERT INTO public.stock_movements (
    inventory_item_id,
    facility_id,
    tenant_id,
    movement_type,
    quantity,
    balance_after,
    batch_number,
    expiry_date,
    unit_cost,
    total_cost,
    created_by,
    reference_number,
    notes
  ) VALUES (
    p_inventory_item_id,
    p_actor_facility_id,
    p_actor_tenant_id,
    v_effective_movement_type,
    p_quantity,
    v_new_balance,
    NULLIF(trim(COALESCE(p_batch_number, '')), ''),
    p_expiry_date,
    p_unit_cost,
    CASE WHEN p_unit_cost IS NULL THEN NULL ELSE ROUND(p_unit_cost * p_quantity, 2) END,
    p_actor_profile_id,
    NULLIF(trim(COALESCE(p_reference_number, '')), ''),
    NULLIF(trim(COALESCE(p_notes, '')), '')
  )
  RETURNING *
  INTO v_inserted;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.backend_finalize_receiving_invoice(
  p_actor_facility_id UUID,
  p_actor_tenant_id UUID,
  p_actor_profile_id UUID,
  p_invoice_id UUID,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice public.receiving_invoices%ROWTYPE;
  v_item_count integer := 0;
  v_stock_movement_count integer := 0;
  v_request_closed boolean := false;
  v_current_balance integer := 0;
  v_new_balance integer := 0;
  v_now timestamptz := now();
  v_row record;
BEGIN
  IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL OR p_actor_profile_id IS NULL THEN
    RAISE EXCEPTION 'Missing facility or tenant context';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Receiving invoice requires at least one line item';
  END IF;

  SELECT *
  INTO v_invoice
  FROM public.receiving_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.facility_id <> p_actor_facility_id OR v_invoice.tenant_id <> p_actor_tenant_id THEN
    RAISE EXCEPTION 'Receiving invoice is outside your facility';
  END IF;

  IF v_invoice.status <> 'draft' THEN
    RAISE EXCEPTION 'Invoice is already submitted';
  END IF;

  CREATE TEMP TABLE tmp_receiving_items (
    id UUID,
    inventory_item_id UUID,
    quantity integer,
    batch_no text,
    expiry_date date,
    unit_cost numeric(10, 2),
    unit_selling_price numeric(10, 2)
  ) ON COMMIT DROP;

  INSERT INTO tmp_receiving_items (
    id,
    inventory_item_id,
    quantity,
    batch_no,
    expiry_date,
    unit_cost,
    unit_selling_price
  )
  SELECT
    x.id,
    x.inventory_item_id,
    x.quantity,
    x.batch_no,
    x.expiry_date,
    x.unit_cost,
    x.unit_selling_price
  FROM jsonb_to_recordset(p_items) AS x(
    id UUID,
    inventory_item_id UUID,
    quantity integer,
    batch_no text,
    expiry_date date,
    unit_cost numeric(10, 2),
    unit_selling_price numeric(10, 2)
  );

  SELECT COUNT(*) INTO v_item_count FROM tmp_receiving_items;
  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'Receiving invoice requires at least one line item';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tmp_receiving_items
    WHERE inventory_item_id IS NULL
      OR quantity IS NULL
      OR quantity <= 0
      OR unit_cost IS NULL
      OR unit_cost < 0
      OR batch_no IS NULL
      OR btrim(batch_no) = ''
  ) THEN
    RAISE EXCEPTION 'Receiving invoice items must include item, positive quantity, cost, and batch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tmp_receiving_items t
    LEFT JOIN public.inventory_items ii
      ON ii.id = t.inventory_item_id
    WHERE ii.id IS NULL
       OR ii.facility_id <> p_actor_facility_id
       OR ii.tenant_id <> p_actor_tenant_id
  ) THEN
    RAISE EXCEPTION 'Inventory item not found in your facility';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tmp_receiving_items t
    WHERE t.id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.receiving_invoice_items rii
        WHERE rii.id = t.id
          AND rii.invoice_id = p_invoice_id
      )
  ) THEN
    RAISE EXCEPTION 'Invoice item does not belong to this invoice';
  END IF;

  UPDATE public.receiving_invoice_items rii
  SET
    inventory_item_id = t.inventory_item_id,
    quantity = t.quantity,
    batch_no = t.batch_no,
    expiry_date = t.expiry_date,
    unit_cost = t.unit_cost,
    unit_selling_price = t.unit_selling_price
  FROM tmp_receiving_items t
  WHERE t.id IS NOT NULL
    AND rii.id = t.id
    AND rii.invoice_id = p_invoice_id;

  INSERT INTO public.receiving_invoice_items (
    invoice_id,
    tenant_id,
    inventory_item_id,
    quantity,
    batch_no,
    expiry_date,
    unit_cost,
    unit_selling_price
  )
  SELECT
    p_invoice_id,
    p_actor_tenant_id,
    t.inventory_item_id,
    t.quantity,
    t.batch_no,
    t.expiry_date,
    t.unit_cost,
    t.unit_selling_price
  FROM tmp_receiving_items t
  WHERE t.id IS NULL;

  FOR v_row IN
    SELECT id, inventory_item_id, quantity, batch_no, expiry_date, unit_cost
    FROM public.receiving_invoice_items
    WHERE invoice_id = p_invoice_id
      AND quantity > 0
    ORDER BY id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('inventory_item:' || v_row.inventory_item_id::text));

    SELECT COALESCE(cs.current_quantity, 0)
    INTO v_current_balance
    FROM public.current_stock cs
    WHERE cs.inventory_item_id = v_row.inventory_item_id
      AND cs.facility_id = p_actor_facility_id
      AND cs.tenant_id = p_actor_tenant_id
    LIMIT 1;

    v_new_balance := v_current_balance + COALESCE(v_row.quantity, 0);

    INSERT INTO public.stock_movements (
      inventory_item_id,
      facility_id,
      tenant_id,
      movement_type,
      quantity,
      balance_after,
      batch_number,
      expiry_date,
      unit_cost,
      total_cost,
      created_by,
      reference_number,
      notes
    ) VALUES (
      v_row.inventory_item_id,
      p_actor_facility_id,
      p_actor_tenant_id,
      'receipt',
      v_row.quantity,
      v_new_balance,
      v_row.batch_no,
      v_row.expiry_date,
      v_row.unit_cost,
      CASE WHEN v_row.unit_cost IS NULL THEN NULL ELSE ROUND(v_row.unit_cost * v_row.quantity, 2) END,
      p_actor_profile_id,
      'INV-' || COALESCE(v_invoice.invoice_no, 'REF'),
      'Received via Receiving (GRN)'
    );

    v_stock_movement_count := v_stock_movement_count + 1;
  END LOOP;

  UPDATE public.receiving_invoices
  SET
    status = 'submitted',
    submitted_at = v_now,
    updated_at = v_now
  WHERE id = p_invoice_id;

  IF v_invoice.request_id IS NOT NULL THEN
    WITH request_totals AS (
      SELECT
        rii.inventory_item_id,
        SUM(COALESCE(rii.quantity, 0)) AS received,
        MAX(COALESCE(rii.requested_quantity, 0)) AS requested
      FROM public.receiving_invoice_items rii
      JOIN public.receiving_invoices ri
        ON ri.id = rii.invoice_id
      WHERE ri.request_id = v_invoice.request_id
        AND ri.status = 'submitted'
      GROUP BY rii.inventory_item_id
    )
    SELECT
      COUNT(*) > 0
      AND bool_and(received >= requested)
    INTO v_request_closed
    FROM request_totals;

    IF v_request_closed THEN
      UPDATE public.request_for_resupply
      SET
        status = 'fulfilled',
        updated_at = v_now
      WHERE id = v_invoice.request_id
        AND facility_id = p_actor_facility_id
        AND tenant_id = p_actor_tenant_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'requestClosed', v_request_closed,
    'stockMovementCount', v_stock_movement_count,
    'submittedAt', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.backend_commit_physical_inventory_session(
  p_actor_facility_id UUID,
  p_actor_tenant_id UUID,
  p_actor_profile_id UUID,
  p_session_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.physical_inventory_sessions%ROWTYPE;
  v_item record;
  v_current_balance integer := 0;
  v_physical_total integer := 0;
  v_variance integer := 0;
  v_balance integer := 0;
  v_unit_cost numeric(10, 2) := 0;
  v_now timestamptz := now();
  v_movement_count integer := 0;
BEGIN
  IF p_actor_facility_id IS NULL OR p_actor_tenant_id IS NULL OR p_actor_profile_id IS NULL THEN
    RAISE EXCEPTION 'Missing facility or tenant context';
  END IF;

  SELECT *
  INTO v_session
  FROM public.physical_inventory_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Physical inventory session not found';
  END IF;

  IF v_session.facility_id <> p_actor_facility_id OR v_session.tenant_id <> p_actor_tenant_id THEN
    RAISE EXCEPTION 'Physical inventory session is outside your facility';
  END IF;

  IF v_session.status <> 'draft' THEN
    RAISE EXCEPTION 'Physical inventory session cannot be committed from current status';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.physical_inventory_session_items
    WHERE session_id = p_session_id
  ) THEN
    RAISE EXCEPTION 'Physical inventory session has no items to commit';
  END IF;

  FOR v_item IN
    SELECT
      pisi.id,
      pisi.inventory_item_id,
      pisi.batch_no,
      pisi.expiry_date,
      pisi.qty_sound,
      pisi.qty_damaged,
      pisi.qty_expired,
      pisi.new_unit_cost,
      COALESCE(ii.unit_cost, 0) AS default_unit_cost
    FROM public.physical_inventory_session_items pisi
    JOIN public.inventory_items ii
      ON ii.id = pisi.inventory_item_id
    WHERE pisi.session_id = p_session_id
    ORDER BY pisi.id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('inventory_item:' || v_item.inventory_item_id::text));

    SELECT COALESCE(cs.current_quantity, 0)
    INTO v_current_balance
    FROM public.current_stock cs
    WHERE cs.inventory_item_id = v_item.inventory_item_id
      AND cs.facility_id = p_actor_facility_id
      AND cs.tenant_id = p_actor_tenant_id
    LIMIT 1;

    UPDATE public.physical_inventory_session_items
    SET
      system_qty = v_current_balance,
      updated_at = v_now
    WHERE id = v_item.id;

    v_physical_total := COALESCE(v_item.qty_sound, 0) + COALESCE(v_item.qty_damaged, 0) + COALESCE(v_item.qty_expired, 0);
    v_variance := v_physical_total - v_current_balance;
    v_balance := v_current_balance;
    v_unit_cost := COALESCE(v_item.new_unit_cost, v_item.default_unit_cost, 0);

    IF v_variance > 0 THEN
      v_balance := v_balance + v_variance;
      INSERT INTO public.stock_movements (
        inventory_item_id,
        facility_id,
        tenant_id,
        movement_type,
        quantity,
        balance_after,
        batch_number,
        expiry_date,
        unit_cost,
        total_cost,
        created_by,
        reference_number,
        notes
      ) VALUES (
        v_item.inventory_item_id,
        p_actor_facility_id,
        p_actor_tenant_id,
        'adjustment',
        v_variance,
        v_balance,
        v_item.batch_no,
        v_item.expiry_date,
        v_unit_cost,
        ROUND(v_unit_cost * v_variance, 2),
        p_actor_profile_id,
        v_session.inventory_id,
        'Physical inventory reconciliation gain'
      );
      v_movement_count := v_movement_count + 1;
    ELSIF v_variance < 0 THEN
      v_balance := v_balance - ABS(v_variance);
      INSERT INTO public.stock_movements (
        inventory_item_id,
        facility_id,
        tenant_id,
        movement_type,
        quantity,
        balance_after,
        batch_number,
        expiry_date,
        unit_cost,
        total_cost,
        created_by,
        reference_number,
        notes
      ) VALUES (
        v_item.inventory_item_id,
        p_actor_facility_id,
        p_actor_tenant_id,
        'loss',
        ABS(v_variance),
        v_balance,
        v_item.batch_no,
        v_item.expiry_date,
        v_unit_cost,
        ROUND(v_unit_cost * ABS(v_variance), 2),
        p_actor_profile_id,
        v_session.inventory_id,
        'Physical inventory shrinkage'
      );
      v_movement_count := v_movement_count + 1;
    END IF;

    IF COALESCE(v_item.qty_damaged, 0) > 0 THEN
      IF v_balance < v_item.qty_damaged THEN
        RAISE EXCEPTION 'Insufficient stock to post damaged quantity';
      END IF;
      v_balance := v_balance - v_item.qty_damaged;
      INSERT INTO public.stock_movements (
        inventory_item_id,
        facility_id,
        tenant_id,
        movement_type,
        quantity,
        balance_after,
        batch_number,
        expiry_date,
        unit_cost,
        total_cost,
        created_by,
        reference_number,
        notes
      ) VALUES (
        v_item.inventory_item_id,
        p_actor_facility_id,
        p_actor_tenant_id,
        'damaged',
        v_item.qty_damaged,
        v_balance,
        v_item.batch_no,
        v_item.expiry_date,
        v_unit_cost,
        ROUND(v_unit_cost * v_item.qty_damaged, 2),
        p_actor_profile_id,
        v_session.inventory_id,
        'Physical inventory damaged stock'
      );
      v_movement_count := v_movement_count + 1;
    END IF;

    IF COALESCE(v_item.qty_expired, 0) > 0 THEN
      IF v_balance < v_item.qty_expired THEN
        RAISE EXCEPTION 'Insufficient stock to post expired quantity';
      END IF;
      v_balance := v_balance - v_item.qty_expired;
      INSERT INTO public.stock_movements (
        inventory_item_id,
        facility_id,
        tenant_id,
        movement_type,
        quantity,
        balance_after,
        batch_number,
        expiry_date,
        unit_cost,
        total_cost,
        created_by,
        reference_number,
        notes
      ) VALUES (
        v_item.inventory_item_id,
        p_actor_facility_id,
        p_actor_tenant_id,
        'expired',
        v_item.qty_expired,
        v_balance,
        v_item.batch_no,
        v_item.expiry_date,
        v_unit_cost,
        ROUND(v_unit_cost * v_item.qty_expired, 2),
        p_actor_profile_id,
        v_session.inventory_id,
        'Physical inventory expired stock'
      );
      v_movement_count := v_movement_count + 1;
    END IF;
  END LOOP;

  UPDATE public.physical_inventory_sessions
  SET
    status = 'committed',
    committed_at = v_now,
    committed_by = p_actor_profile_id,
    updated_at = v_now
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'success', true,
    'movementCount', v_movement_count,
    'committedAt', v_now
  );
END;
$$;

COMMIT;
