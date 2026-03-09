/**
 * Agent Portal Routes
 * Regional agents collect cash payments and deliver activation codes
 * to offline clinics that never connect to the internet.
 */

import express from 'express';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';
import { activateSubscription } from '../services/subscriptionService';
import { issueLicense } from '../services/licenseService';
import { invalidateSubscriptionCache } from '../middleware/subscriptionGuard';

const router = express.Router();

function requireAgent(req: any, res: any, next: any) {
  if (!['agent', 'super_admin', 'admin'].includes(req.user?.role || '')) {
    return res.status(403).json({ error: 'Agent access required' });
  }
  next();
}

// ── GET /api/agent/my-clinics ─────────────────────────────────────────────
router.get('/my-clinics', requireUser, requireScopedUser, requireAgent, async (req, res) => {
  try {
    const { profileId } = req.user as any;
    const { data: agent } = await supabaseAdmin.from('agents').select('id').eq('user_id', profileId).single();
    if (!agent) return res.status(404).json({ error: 'Agent record not found' });

    const { data, error } = await supabaseAdmin
      .from('agent_assignments')
      .select(`tenant_id, tenants(id, name, subscription_status, subscription_tier, trial_expires_at, subscription_expires_at, contact_phone, contact_email)`)
      .eq('agent_id', agent.id);

    if (error) throw error;
    res.json({ success: true, clinics: data?.map((r: any) => r.tenants) || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/agent/collect-payment ──────────────────────────────────────
// Agent records cash/mobile money payment and issues activation code
router.post('/collect-payment', requireUser, requireScopedUser, requireAgent, async (req, res) => {
  try {
    const { profileId } = req.user as any;
    const { tenantId, tier, periodMonths = 1, gateway = 'agent_cash', amountETB, hubId, mobileReference, notes } = req.body;

    if (!tenantId || !tier) return res.status(400).json({ error: 'tenantId and tier required' });

    const { data: agent } = await supabaseAdmin.from('agents').select('id, commission_rate').eq('user_id', profileId).single();
    if (!agent) return res.status(404).json({ error: 'Agent record not found' });

    const reference = `AGT-${Date.now().toString(36).toUpperCase()}`;

    // Record confirmed payment immediately (agent has collected cash)
    const { data: payment, error: pe } = await supabaseAdmin
      .from('payment_events')
      .insert({
        tenant_id: tenantId,
        hub_id: hubId || null,
        gateway,
        gateway_reference: reference,
        gateway_tx_id: mobileReference || null,
        amount: amountETB || 0,
        currency: 'ETB',
        plan_tier: tier,
        period_months: periodMonths,
        period_start: new Date().toISOString(),
        period_end: new Date(Date.now() + periodMonths * 30 * 86_400_000).toISOString(),
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
        confirmed_by: profileId,
        notes,
      })
      .select()
      .single();
    if (pe) throw pe;

    // Activate subscription
    await activateSubscription(tenantId, periodMonths, tier);
    invalidateSubscriptionCache(tenantId);

    // Issue license key
    let license = null;
    if (hubId) {
      license = await issueLicense({
        tenantId,
        hubId,
        tier,
        periodMonths,
        paymentEventId: payment?.id,
        deliveredVia: 'agent',
      });
    }

    // Record commission
    if (payment) {
      const commission = (payment.amount * agent.commission_rate) / 100;
      await supabaseAdmin.from('agent_commissions').insert({
        agent_id: agent.id,
        payment_event_id: payment.id,
        amount: commission,
        currency: 'ETB',
        status: 'pending',
      });
    }

    res.json({
      success: true,
      reference,
      activationCode: license?.activationCode || null,
      licenseExpiresAt: license?.expiresAt || null,
      message: license
        ? `Activation code: ${license.activationCode} — valid until ${new Date(license.expiresAt).toLocaleDateString()}`
        : 'Subscription activated (cloud only)',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/agent/commissions ───────────────────────────────────────────
router.get('/commissions', requireUser, requireScopedUser, requireAgent, async (req, res) => {
  try {
    const { profileId } = req.user as any;
    const { data: agent } = await supabaseAdmin.from('agents').select('id').eq('user_id', profileId).single();
    if (!agent) return res.status(404).json({ error: 'Agent record not found' });

    const { data, error } = await supabaseAdmin
      .from('agent_commissions')
      .select('*, payment_events(tenant_id, plan_tier, period_months, amount, currency, confirmed_at)')
      .eq('agent_id', agent.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    const pending = data?.filter((c: any) => c.status === 'pending').reduce((s: number, c: any) => s + Number(c.amount), 0) || 0;
    const paid    = data?.filter((c: any) => c.status === 'paid').reduce((s: number, c: any) => s + Number(c.amount), 0) || 0;

    res.json({ success: true, commissions: data, summary: { pendingETB: pending, paidETB: paid } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
