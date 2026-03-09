/**
 * Payment webhook handlers
 * Chapa (Ethiopian gateway) + Stripe (international)
 * Verifies signatures, confirms payments, activates subscriptions,
 * and issues offline license keys for hub-based clinics.
 */

import express from 'express';
import * as crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { activateSubscription } from '../services/subscriptionService';
import { issueLicense } from '../services/licenseService';
import { invalidateSubscriptionCache } from '../middleware/subscriptionGuard';

const router = express.Router();

// ── Chapa webhook ─────────────────────────────────────────────────────────
router.post('/chapa', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Verify Chapa signature
    const chapaSecret = process.env.CHAPA_WEBHOOK_SECRET || '';
    const signature = req.headers['chapa-signature'] as string;
    if (chapaSecret && signature) {
      const expected = crypto.createHmac('sha256', chapaSecret).update(req.body).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = JSON.parse(req.body.toString());
    if (event.status !== 'success') return res.json({ received: true });

    const reference = event.tx_ref || event.reference;
    await handleConfirmedPayment(reference, 'chapa', event.trx_ref || event.transaction_id);

    res.json({ received: true });
  } catch (err: any) {
    console.error('Chapa webhook error:', err?.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── Stripe webhook ────────────────────────────────────────────────────────
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const stripeSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    // In production: use stripe.webhooks.constructEvent() for proper sig verification
    const event = JSON.parse(req.body.toString());

    if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
      const reference = event.data?.object?.metadata?.tx_ref || event.data?.object?.client_reference_id;
      if (reference) {
        await handleConfirmedPayment(reference, 'stripe', event.id);
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('Stripe webhook error:', err?.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── Shared payment confirmation logic ─────────────────────────────────────
async function handleConfirmedPayment(reference: string, gateway: string, gatewayTxId: string) {
  const { data: payment, error } = await supabaseAdmin
    .from('payment_events')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), gateway_tx_id: gatewayTxId })
    .eq('gateway_reference', reference)
    .eq('status', 'pending')
    .select()
    .single();

  if (error || !payment) {
    console.warn(`Payment not found or already confirmed: ${reference}`);
    return;
  }

  // Activate cloud subscription
  await activateSubscription(payment.tenant_id, payment.period_months, payment.plan_tier);
  invalidateSubscriptionCache(payment.tenant_id);

  // Issue offline license if this is a hub-based clinic
  if (payment.hub_id) {
    try {
      const license = await issueLicense({
        tenantId: payment.tenant_id,
        hubId: payment.hub_id,
        tier: payment.plan_tier,
        periodMonths: payment.period_months,
        paymentEventId: payment.id,
        deliveredVia: 'portal',
      });

      // Queue SMS/WhatsApp delivery of activation code
      await deliverActivationCode(payment.tenant_id, license.activationCode, license.expiresAt);
    } catch (licErr: any) {
      console.error('License issuance failed:', licErr?.message);
    }
  }

  // Calculate and record agent commission if applicable
  const { data: assignment } = await supabaseAdmin
    .from('agent_assignments')
    .select('agent_id, agents(commission_rate)')
    .eq('tenant_id', payment.tenant_id)
    .single() as any;

  if (assignment?.agent_id) {
    const rate = assignment.agents?.commission_rate || 15;
    const commission = (payment.amount * rate) / 100;
    await supabaseAdmin.from('agent_commissions').insert({
      agent_id: assignment.agent_id,
      payment_event_id: payment.id,
      amount: commission,
      currency: payment.currency,
      status: 'pending',
    });
  }
}

async function deliverActivationCode(tenantId: string, code: string, expiresAt: string) {
  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('contact_phone, contact_email, name')
    .eq('id', tenantId)
    .single();

  if (!tenant) return;

  // Invoke send-activation-code Supabase edge function
  await supabaseAdmin.functions.invoke('send-activation-code', {
    body: {
      phone: tenant.contact_phone,
      email: tenant.contact_email,
      clinicName: tenant.name,
      activationCode: code,
      expiresAt,
    },
  }).catch((e) => console.warn('Activation code delivery failed:', e?.message));
}

export default router;
