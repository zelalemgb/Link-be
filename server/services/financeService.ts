import { supabaseAdmin } from '../config/supabase';
import { PAYMENT_STATUS, type PaymentStatus } from '../../shared/contracts/payment';

export type PaymentItem = {
  referenceId: string;
  itemType: 'medication' | 'lab_test' | 'imaging' | 'service';
  price: number;
  qty: number;
  payment: string;
  description?: string;
};

export type PaymentPayload = {
  visitId: string;
  patientId: string;
  items: PaymentItem[];
  allItemsPaid: boolean;
  tenantId: string;
  facilityId: string;
  userId: string;
};

const requiresRpc = () => process.env.PAYMENTS_REQUIRE_RPC === 'true';

const updatePaymentStatus = async (
  visitId: string,
  facilityId: string,
  status: PaymentStatus,
  updatedAt: string
) => {
  await supabaseAdmin
    .from('payments')
    .update({
      payment_status: status,
      updated_at: updatedAt,
    })
    .eq('visit_id', visitId)
    .eq('facility_id', facilityId);
};

export const processPayment = async (payload: PaymentPayload) => {
  const { visitId, patientId, items, allItemsPaid, tenantId, facilityId, userId } = payload;
  const now = new Date().toISOString();

  if (items.length === 0) {
    await supabaseAdmin
      .from('visits')
      .update({
        routing_status: 'awaiting_routing',
        status_updated_at: now,
      })
      .eq('id', visitId);
    return { success: true };
  }

  const rpcItems = items.map(item => ({
    reference_id: item.referenceId,
    type: item.itemType,
    qty: item.qty,
    unit_price: item.price,
    payment_mode: item.payment,
    label: item.description || '',
  }));

  const cashAmount = items
    .filter(item => item.payment === 'cash')
    .reduce((sum, item) => sum + item.price * item.qty, 0);

  const { error: rpcError } = await supabaseAdmin.rpc('process_payment_bulk', {
    p_visit_id: visitId,
    p_patient_id: patientId,
    p_facility_id: facilityId,
    p_cashier_id: userId,
    p_cash_amount: cashAmount,
    p_items: rpcItems,
  });

  if (rpcError && rpcError.code !== 'PGRST202') {
    console.error('[Payment] process_payment_bulk failed', {
      message: rpcError.message,
      details: rpcError.details,
      hint: rpcError.hint,
      code: rpcError.code,
      visitId,
      itemCount: rpcItems.length,
    });
    throw rpcError;
  }

  if (rpcError?.code === 'PGRST202') {
    if (requiresRpc()) {
      throw new Error('Payment processing RPC is required but unavailable.');
    }

    const medicationUpdates = items
      .filter(i => i.itemType === 'medication')
      .map(i => supabaseAdmin
        .from('medication_orders')
        .update({
          payment_status: PAYMENT_STATUS.PAID,
          payment_mode: i.payment,
          amount: i.price * i.qty,
          paid_at: now,
        })
        .eq('id', i.referenceId)
      );

    const labUpdates = items
      .filter(i => i.itemType === 'lab_test')
      .map(i => supabaseAdmin
        .from('lab_orders')
        .update({
          payment_status: PAYMENT_STATUS.PAID,
          payment_mode: i.payment,
          amount: i.price * i.qty,
          paid_at: now,
        })
        .eq('id', i.referenceId)
      );

    const imagingUpdates = items
      .filter(i => i.itemType === 'imaging')
      .map(i => supabaseAdmin
        .from('imaging_orders')
        .update({
          payment_status: PAYMENT_STATUS.PAID,
          payment_mode: i.payment,
          amount: i.price * i.qty,
          paid_at: now,
        })
        .eq('id', i.referenceId)
      );

    const serviceUpdates = items
      .filter(i => i.itemType === 'service')
      .map(i => supabaseAdmin
        .from('billing_items')
        .update({
          payment_status: PAYMENT_STATUS.PAID,
          payment_mode: i.payment,
          paid_at: now,
        })
        .eq('id', i.referenceId)
      );

    await Promise.all([
      ...medicationUpdates,
      ...labUpdates,
      ...imagingUpdates,
      ...serviceUpdates,
    ]);

    if (items.length > 0) {
      const lineItems = items.map(line => ({
        payment_id: null,
        item_type: line.itemType,
        item_reference_id: line.referenceId,
        description: line.description || '',
        quantity: line.qty,
        unit_price: line.price,
        subtotal: line.price * line.qty,
        payment_method: line.payment,
        payment_status: PAYMENT_STATUS.PAID,
        final_amount: line.payment === 'free' ? 0 : line.price * line.qty,
        discount_percentage: 0,
        discount_amount: 0,
      }));

      const { data: existingPayment } = await supabaseAdmin
        .from('payments')
        .select('id')
        .eq('visit_id', visitId)
        .eq('facility_id', facilityId)
        .maybeSingle();

      let paymentId = existingPayment?.id;
      const status = allItemsPaid ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.PARTIAL;

      if (!paymentId) {
        const { data: newPayment, error: payError } = await supabaseAdmin
          .from('payments')
          .insert({
            visit_id: visitId,
            patient_id: patientId,
            facility_id: facilityId,
            tenant_id: tenantId,
            cashier_id: userId,
            payment_status: status,
          })
          .select('id')
          .single();

        if (payError) throw payError;
        paymentId = newPayment.id;
      } else {
        await supabaseAdmin
          .from('payments')
          .update({
            cashier_id: userId,
            payment_status: status,
            updated_at: now,
          })
          .eq('id', paymentId);
      }

      const lineItemsWithId = lineItems.map(li => ({
        ...li,
        payment_id: paymentId,
      }));

      const { error: linesError } = await supabaseAdmin
        .from('payment_line_items')
        .insert(lineItemsWithId);

      if (linesError) {
        console.error('[Payment] ERROR inserting line items:', linesError);
        console.error('[Payment] Failed line items:', JSON.stringify(lineItemsWithId, null, 2));
      }
    }
  } else if (!allItemsPaid) {
    await updatePaymentStatus(visitId, facilityId, PAYMENT_STATUS.PARTIAL, now);
  }

  return { success: true };
};
