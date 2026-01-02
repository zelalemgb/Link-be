-- Create RPC to record multiple payment method allocations in one call
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
  allocation jsonb;
  allocation_amount numeric(12,2);
  allocation_method text;
  payment_record payments%ROWTYPE;
  cashier_record users%ROWTYPE;
  inserted_record payment_transactions%ROWTYPE;
  transactions jsonb := '[]'::jsonb;
  total_allocated numeric(12,2) := 0;
  updated_payment RECORD;
  allowed_roles CONSTANT text[] := ARRAY['finance', 'cashier', 'receptionist', 'admin', 'super_admin'];
  auth_user uuid;
BEGIN
  auth_user := auth.uid();

  IF auth_user IS NULL THEN
    RAISE EXCEPTION 'Authentication is required to record payments';
  END IF;

  IF method_allocations IS NULL OR jsonb_typeof(method_allocations) <> 'array' THEN
    RAISE EXCEPTION 'method_allocations must be provided as an array';
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

  IF cashier_record.user_role IS NULL OR NOT (cashier_record.user_role = ANY(allowed_roles)) THEN
    RAISE EXCEPTION 'Role % is not permitted to allocate payments', cashier_record.user_role;
  END IF;

  FOR allocation IN SELECT value FROM jsonb_array_elements(method_allocations)
  LOOP
    IF jsonb_typeof(allocation) <> 'object' THEN
      RAISE EXCEPTION 'Each allocation entry must be an object';
    END IF;

    IF NOT (allocation ? 'payment_method') THEN
      RAISE EXCEPTION 'payment_method is required for each allocation';
    END IF;

    IF NOT (allocation ? 'amount') THEN
      RAISE EXCEPTION 'amount is required for each allocation';
    END IF;

    allocation_method := trim(both from allocation->>'payment_method');

    IF allocation_method IS NULL OR allocation_method = '' THEN
      RAISE EXCEPTION 'payment_method cannot be empty';
    END IF;

    allocation_amount := (allocation->>'amount')::numeric;

    IF allocation_amount <= 0 THEN
      RAISE EXCEPTION 'amount must be greater than zero';
    END IF;

    inserted_record := (
      INSERT INTO public.payment_transactions (
        payment_id,
        tenant_id,
        amount,
        payment_method,
        reference_number,
        cashier_id,
        transaction_date,
        notes
      )
      VALUES (
        payment_id,
        payment_record.tenant_id,
        allocation_amount,
        allocation_method,
        NULLIF(trim(both from allocation->>'reference_number'), ''),
        cashier_record.id,
        COALESCE((allocation->>'transaction_date')::timestamptz, now()),
        NULLIF(trim(both from allocation->>'notes'), '')
      )
      RETURNING *
    );

    total_allocated := total_allocated + inserted_record.amount;

    transactions := transactions || jsonb_build_array(
      jsonb_build_object(
        'id', inserted_record.id,
        'amount', inserted_record.amount,
        'payment_method', inserted_record.payment_method,
        'reference_number', inserted_record.reference_number,
        'notes', inserted_record.notes,
        'transaction_date', inserted_record.transaction_date
      )
    );
  END LOOP;

  UPDATE public.payments p
  SET amount_paid = p.amount_paid + total_allocated,
      amount_due = GREATEST(0, p.total_amount - (p.amount_paid + total_allocated)),
      payment_status = CASE
        WHEN p.total_amount <= p.amount_paid + total_allocated THEN 'paid'
        ELSE 'partial'
      END,
      updated_at = now()
  WHERE p.id = payment_id
  RETURNING p.amount_paid, p.amount_due, p.payment_status, p.total_amount
  INTO updated_payment;

  RETURN jsonb_build_object(
    'payment', jsonb_build_object(
      'id', payment_id,
      'total_amount', updated_payment.total_amount,
      'amount_paid', updated_payment.amount_paid,
      'amount_due', updated_payment.amount_due,
      'payment_status', updated_payment.payment_status
    ),
    'total_allocated', total_allocated,
    'transactions', transactions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_payment_method_allocations(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_payment_method_allocations(uuid, uuid, jsonb) TO authenticated, service_role;
