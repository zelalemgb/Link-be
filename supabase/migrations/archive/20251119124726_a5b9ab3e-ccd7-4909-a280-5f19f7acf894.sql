-- Phase 1: Add routing_status column to visits table for database-driven routing state management
-- This eliminates the need for ephemeral React state to track patients awaiting routing after payment

-- Add routing_status column with check constraint
ALTER TABLE public.visits 
ADD COLUMN IF NOT EXISTS routing_status TEXT 
CHECK (routing_status IN ('completed', 'awaiting_routing', 'routing_in_progress'))
DEFAULT 'completed';

-- Backfill existing data: set awaiting_routing for paid visits in paying stages
UPDATE public.visits
SET routing_status = 'awaiting_routing'
WHERE status IN ('paying_diagnosis', 'paying_consultation', 'paying_pharmacy')
  AND EXISTS (
    SELECT 1 FROM payments
    WHERE payments.visit_id = visits.id
      AND payments.payment_status = 'paid'
  )
  AND routing_status = 'completed';

-- Add partial index for optimized cashier queue queries
CREATE INDEX IF NOT EXISTS idx_visits_routing_status 
ON public.visits(routing_status, facility_id, status_updated_at DESC)
WHERE routing_status = 'awaiting_routing';

-- Add documentation comment
COMMENT ON COLUMN visits.routing_status IS 
'Tracks patient routing workflow state after payment: completed (routed), awaiting_routing (paid but not routed), routing_in_progress (being routed). Single source of truth for cashier routing workflow.';

-- Phase 2.1: Update apply_payment_method_allocations RPC to set routing_status
CREATE OR REPLACE FUNCTION public.apply_payment_method_allocations(
  payment_id uuid,
  cashier_id uuid,
  method_allocations jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  payment_record public.payments%ROWTYPE;
  cashier_record public.users%ROWTYPE;
  auth_user uuid;
  allocation jsonb;
  total_allocated numeric := 0;
  transactions jsonb := '[]'::jsonb;
  updated_payment public.payments%ROWTYPE;
BEGIN
  auth_user := auth.uid();

  IF auth_user IS NULL THEN
    RAISE EXCEPTION 'User must be authenticated';
  END IF;

  IF payment_id IS NULL THEN
    RAISE EXCEPTION 'payment_id cannot be null';
  END IF;

  IF cashier_id IS NULL THEN
    RAISE EXCEPTION 'cashier_id cannot be null';
  END IF;

  IF method_allocations IS NULL THEN
    RAISE EXCEPTION 'method_allocations cannot be null';
  END IF;

  IF jsonb_array_length(method_allocations) = 0 THEN
    RAISE EXCEPTION 'method_allocations cannot be empty';
  END IF;

  SELECT *
  INTO payment_record
  FROM public.payments
  WHERE id = apply_payment_method_allocations.payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', payment_id;
  END IF;

  SELECT *
  INTO cashier_record
  FROM public.users u
  WHERE u.id = apply_payment_method_allocations.cashier_id
    AND u.auth_user_id = auth_user;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authenticated user is not authorized for cashier %', cashier_id;
  END IF;

  IF cashier_record.facility_id IS DISTINCT FROM payment_record.facility_id THEN
    RAISE EXCEPTION 'Cashier facility does not match the payment facility';
  END IF;

  FOR allocation IN SELECT * FROM jsonb_array_elements(method_allocations)
  LOOP
    DECLARE
      method_name text;
      allocation_amount numeric;
      ref_number text;
      txn_notes text;
      txn_date timestamptz;
      transaction_id uuid;
    BEGIN
      method_name := allocation->>'payment_method';
      allocation_amount := (allocation->>'amount')::numeric;
      ref_number := allocation->>'reference_number';
      txn_notes := allocation->>'notes';
      txn_date := COALESCE((allocation->>'transaction_date')::timestamptz, now());

      IF method_name IS NULL OR method_name = '' THEN
        RAISE EXCEPTION 'payment_method is required for each allocation';
      END IF;

      IF allocation_amount IS NULL OR allocation_amount <= 0 THEN
        RAISE EXCEPTION 'amount must be positive for each allocation';
      END IF;

      total_allocated := total_allocated + allocation_amount;

      INSERT INTO public.payment_transactions (
        tenant_id,
        payment_id,
        cashier_id,
        amount,
        payment_method,
        reference_number,
        notes,
        transaction_date
      ) VALUES (
        payment_record.tenant_id,
        payment_record.id,
        cashier_record.id,
        allocation_amount,
        method_name,
        ref_number,
        txn_notes,
        txn_date
      )
      RETURNING id INTO transaction_id;

      transactions := transactions || jsonb_build_object(
        'id', transaction_id,
        'amount', allocation_amount,
        'payment_method', method_name,
        'reference_number', ref_number,
        'transaction_date', txn_date
      );
    END;
  END LOOP;

  UPDATE public.payments
  SET
    amount_paid = amount_paid + total_allocated,
    amount_due = GREATEST(total_amount - (amount_paid + total_allocated), 0),
    payment_status = CASE
      WHEN (total_amount - (amount_paid + total_allocated)) <= 0 THEN 'paid'::public.payment_status_enum
      ELSE 'partial'::public.payment_status_enum
    END,
    updated_at = now()
  WHERE id = payment_record.id
  RETURNING * INTO updated_payment;

  -- NEW: Set routing_status to awaiting_routing when payment is fully paid
  IF updated_payment.payment_status = 'paid' THEN
    UPDATE public.visits
    SET 
      routing_status = 'awaiting_routing',
      status_updated_at = now()
    WHERE id = payment_record.visit_id
      AND routing_status = 'completed';
  END IF;

  RETURN jsonb_build_object(
    'payment', jsonb_build_object(
      'id', updated_payment.id,
      'total_amount', updated_payment.total_amount,
      'amount_paid', updated_payment.amount_paid,
      'amount_due', updated_payment.amount_due,
      'payment_status', updated_payment.payment_status
    ),
    'total_allocated', total_allocated,
    'transactions', transactions,
    'routing_status', CASE 
      WHEN updated_payment.payment_status = 'paid' THEN 'awaiting_routing'
      ELSE 'completed'
    END,
    'requires_routing', updated_payment.payment_status = 'paid'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_payment_method_allocations(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_payment_method_allocations(uuid, uuid, jsonb) TO authenticated, service_role;

-- Phase 2.2: Update advance_patient_stage RPC to clear routing_status
CREATE OR REPLACE FUNCTION public.advance_patient_stage(
  p_visit_id uuid,
  p_next_stage text,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_stage text;
  v_user_role text;
  v_caller_user_id uuid;
  v_timeline jsonb;
  v_stages jsonb;
  v_allowed_roles text[];
  v_is_authorized boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    SELECT id INTO v_caller_user_id
    FROM public.users
    WHERE auth_user_id = auth.uid()
    LIMIT 1;
  ELSE
    v_caller_user_id := p_user_id;
  END IF;

  IF v_caller_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User not found or not authenticated'
    );
  END IF;

  SELECT user_role INTO v_user_role
  FROM public.users
  WHERE id = v_caller_user_id;

  IF v_user_role = 'super_admin' THEN
    v_is_authorized := true;
  ELSE
    SELECT journey_timeline INTO v_timeline
    FROM public.visits
    WHERE id = p_visit_id;

    IF v_timeline IS NOT NULL AND v_timeline->'stages' IS NOT NULL THEN
      v_stages := v_timeline->'stages';
      IF jsonb_array_length(v_stages) > 0 THEN
        v_current_stage := (v_stages->-1)->>'stage';
      END IF;
    END IF;

    IF v_current_stage IS NULL THEN
      SELECT status INTO v_current_stage
      FROM public.visits
      WHERE id = p_visit_id;
    END IF;

    CASE v_current_stage
      WHEN 'registered' THEN
        v_allowed_roles := ARRAY['receptionist'];
      WHEN 'paying_consultation' THEN
        v_allowed_roles := ARRAY['receptionist', 'cashier'];
      WHEN 'at_triage', 'vitals_taken' THEN
        v_allowed_roles := ARRAY['nurse'];
      WHEN 'with_doctor' THEN
        v_allowed_roles := ARRAY['doctor'];
      WHEN 'paying_diagnosis', 'paying_pharmacy' THEN
        v_allowed_roles := ARRAY['cashier'];
      WHEN 'at_lab' THEN
        v_allowed_roles := ARRAY['lab_technician'];
      WHEN 'at_imaging' THEN
        v_allowed_roles := ARRAY['imaging_technician'];
      WHEN 'at_pharmacy' THEN
        v_allowed_roles := ARRAY['pharmacist'];
      WHEN 'admitted' THEN
        v_allowed_roles := ARRAY['inpatient_nurse', 'doctor'];
      WHEN 'discharged' THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Cannot advance from discharged state'
        );
      ELSE
        v_allowed_roles := ARRAY[]::text[];
    END CASE;

    v_is_authorized := v_user_role = ANY(v_allowed_roles);
  END IF;

  IF NOT v_is_authorized THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('User role "%s" is not authorized to advance from stage "%s"', v_user_role, v_current_stage)
    );
  END IF;

  CASE v_current_stage
    WHEN 'registered' THEN
      IF p_next_stage NOT IN ('paying_consultation', 'at_triage', 'vitals_taken') THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', format('Invalid transition from %s to %s', v_current_stage, p_next_stage)
        );
      END IF;
    WHEN 'paying_consultation' THEN
      IF p_next_stage NOT IN ('at_triage', 'vitals_taken') THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', format('Invalid transition from %s to %s', v_current_stage, p_next_stage)
        );
      END IF;
    ELSE
      NULL;
  END CASE;

  PERFORM public.append_journey_stage(p_visit_id, p_next_stage, v_caller_user_id);

  -- NEW: Clear routing_status since patient has been routed
  UPDATE public.visits
  SET routing_status = 'completed'
  WHERE id = p_visit_id;

  RETURN jsonb_build_object(
    'success', true,
    'new_stage', p_next_stage,
    'previous_stage', v_current_stage,
    'routing_status', 'completed'
  );
END;
$$;

-- Phase 2.3: Create helper function to fetch patients awaiting routing
CREATE OR REPLACE FUNCTION public.get_patients_awaiting_routing(
  p_facility_id UUID
)
RETURNS TABLE (
  visit_id UUID,
  patient_id UUID,
  patient_name TEXT,
  patient_age INTEGER,
  patient_sex TEXT,
  items JSONB,
  wait_minutes INTEGER,
  suggested_next_stage TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    v.id as visit_id,
    p.id as patient_id,
    p.full_name as patient_name,
    p.age as patient_age,
    p.gender as patient_sex,
    COALESCE(
      jsonb_agg(
        DISTINCT jsonb_build_object(
          'id', pli.id,
          'dept', CASE 
            WHEN pli.item_type = 'lab_test' THEN 'Lab'
            WHEN pli.item_type = 'imaging' THEN 'Imaging'
            WHEN pli.item_type = 'medication' THEN 'Pharmacy'
            WHEN pli.item_type = 'consultation' THEN 'Consultation'
            ELSE 'Service'
          END,
          'type', pli.item_type,
          'name', pli.description,
          'amount', pli.final_amount
        )
      ) FILTER (WHERE pli.id IS NOT NULL),
      '[]'::jsonb
    ) as items,
    EXTRACT(EPOCH FROM (now() - v.status_updated_at))::INTEGER / 60 as wait_minutes,
    CASE 
      WHEN EXISTS (
        SELECT 1 FROM payment_line_items pli2
        WHERE pli2.payment_id IN (
          SELECT pay.id FROM payments pay WHERE pay.visit_id = v.id AND pay.payment_status = 'paid'
        )
        AND pli2.item_type = 'lab_test'
      ) THEN 'at_lab'
      WHEN EXISTS (
        SELECT 1 FROM payment_line_items pli2
        WHERE pli2.payment_id IN (
          SELECT pay.id FROM payments pay WHERE pay.visit_id = v.id AND pay.payment_status = 'paid'
        )
        AND pli2.item_type = 'imaging'
      ) THEN 'at_imaging'
      WHEN EXISTS (
        SELECT 1 FROM payment_line_items pli2
        WHERE pli2.payment_id IN (
          SELECT pay.id FROM payments pay WHERE pay.visit_id = v.id AND pay.payment_status = 'paid'
        )
        AND pli2.item_type = 'medication'
      ) THEN 'at_pharmacy'
      ELSE 'at_triage'
    END as suggested_next_stage,
    v.created_at
  FROM visits v
  INNER JOIN patients p ON p.id = v.patient_id
  LEFT JOIN payments pay ON pay.visit_id = v.id AND pay.payment_status = 'paid'
  LEFT JOIN payment_line_items pli ON pli.payment_id = pay.id
  WHERE v.facility_id = p_facility_id
    AND v.routing_status = 'awaiting_routing'
  GROUP BY v.id, p.id, p.full_name, p.age, p.gender, v.status_updated_at, v.created_at
  ORDER BY v.status_updated_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_patients_awaiting_routing(UUID) IS 
'Fetches all patients at a facility who have completed payment and are awaiting routing to their next service by the cashier.';

REVOKE ALL ON FUNCTION public.get_patients_awaiting_routing(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_patients_awaiting_routing(UUID) TO authenticated, service_role;