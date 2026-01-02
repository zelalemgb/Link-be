-- Add RPC to process payments in a single transaction for performance
create or replace function public.process_payment_bulk(
  p_visit_id uuid,
  p_patient_id uuid,
  p_facility_id uuid,
  p_cashier_id uuid,
  p_cash_amount numeric,
  p_items jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_payment_id uuid;
  v_tenant_id uuid;
  v_status text := 'partial';
begin
  -- get tenant from facility
  select tenant_id into v_tenant_id from facilities where id = p_facility_id;

  -- Create or update payment header
  select id into v_payment_id from payments where visit_id = p_visit_id;
  if v_payment_id is null then
    insert into payments (visit_id, patient_id, facility_id, tenant_id, cashier_id, payment_status, payment_date)
    values (p_visit_id, p_patient_id, p_facility_id, v_tenant_id, p_cashier_id, 'pending', v_now)
    returning id into v_payment_id;
  else
    update payments set cashier_id = p_cashier_id, updated_at = v_now where id = v_payment_id;
  end if;

  -- Update orders/services in batch
  with items as (
    select 
      (item->>'reference_id')::uuid as reference_id,
      item->>'type' as item_type,
      (item->>'qty')::numeric as qty,
      (item->>'unit_price')::numeric as unit_price,
      item->>'payment_mode' as payment_mode
    from jsonb_array_elements(p_items) as item
  )
  update lab_orders lo
  set payment_status = 'paid', payment_mode = i.payment_mode, amount = i.unit_price * i.qty, paid_at = v_now
  from items i
  where i.item_type = 'lab_test' and lo.id = i.reference_id;

  with items as (
    select 
      (item->>'reference_id')::uuid as reference_id,
      item->>'type' as item_type,
      (item->>'qty')::numeric as qty,
      (item->>'unit_price')::numeric as unit_price,
      item->>'payment_mode' as payment_mode
    from jsonb_array_elements(p_items) as item
  )
  update imaging_orders io
  set payment_status = 'paid', payment_mode = i.payment_mode, amount = i.unit_price * i.qty, paid_at = v_now
  from items i
  where i.item_type = 'imaging' and io.id = i.reference_id;

  with items as (
    select 
      (item->>'reference_id')::uuid as reference_id,
      item->>'type' as item_type,
      (item->>'qty')::numeric as qty,
      (item->>'unit_price')::numeric as unit_price,
      item->>'payment_mode' as payment_mode
    from jsonb_array_elements(p_items) as item
  )
  update medication_orders mo
  set payment_status = 'paid', payment_mode = i.payment_mode, amount = i.unit_price * i.qty, paid_at = v_now
  from items i
  where i.item_type = 'medication' and mo.id = i.reference_id;

  with items as (
    select 
      (item->>'reference_id')::uuid as reference_id,
      item->>'type' as item_type,
      (item->>'qty')::numeric as qty,
      (item->>'unit_price')::numeric as unit_price,
      item->>'payment_mode' as payment_mode
    from jsonb_array_elements(p_items) as item
  )
  update billing_items bi
  set payment_status = 'paid', payment_mode = i.payment_mode, paid_at = v_now
  from items i
  where i.item_type = 'service' and bi.id = i.reference_id;

  -- Insert payment_line_items
  insert into payment_line_items (
    payment_id, item_type, item_reference_id, description, unit_price, quantity, subtotal, payment_method, payment_status, final_amount, discount_percentage, discount_amount
  )
  select
    v_payment_id,
    case when item->>'type' = 'consultation' then 'consultation' else item->>'type' end,
    (item->>'reference_id')::uuid,
    item->>'label',
    (item->>'unit_price')::numeric,
    (item->>'qty')::numeric,
    (item->>'unit_price')::numeric * (item->>'qty')::numeric,
    item->>'payment_mode',
    'paid',
    case when item->>'payment_mode' = 'free' then 0 else (item->>'unit_price')::numeric * (item->>'qty')::numeric end,
    0,
    0
  from jsonb_array_elements(p_items) as item;

  -- Insert single transaction for cash (other methods can be added similarly)
  if p_cash_amount is not null and p_cash_amount > 0 then
    insert into payment_transactions (payment_id, tenant_id, amount, payment_method, transaction_date, cashier_id, reference_number)
    values (v_payment_id, v_tenant_id, p_cash_amount, 'cash', v_now, p_cashier_id, concat('CASH-', extract(epoch from v_now)::bigint));
  end if;

  -- Mark visit routing_status to awaiting_routing
  update visits set routing_status = 'awaiting_routing', status_updated_at = v_now where id = p_visit_id;

  -- Set payment header status
  update payments set payment_status = 'paid', payment_date = v_now where id = v_payment_id;

end;
$$;
