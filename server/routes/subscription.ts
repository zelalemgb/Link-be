import express from 'express';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';
import { getSubscriptionStatus, activateSubscription, provisionTrial } from '../services/subscriptionService';
import { issueHubSessionToken, issueLicense, activateHubLicense, getPublicKey } from '../services/licenseService';
import { invalidateSubscriptionCache } from '../middleware/subscriptionGuard';
import { recordAuditEvent } from '../services/audit-log';
import { normalizeWorkspaceMetadata } from '../services/workspaceMetadata';

const router = express.Router();

// ── GET /api/subscription/status ─────────────────────────────────────────
router.get('/status', requireUser, requireScopedUser, async (req, res) => {
  try {
    const { tenantId } = req.user as any;
    const status = await getSubscriptionStatus(tenantId);
    const { data: workspaceRow, error: workspaceError } = await supabaseAdmin
      .from('tenants')
      .select('workspace_type, setup_mode, team_mode, enabled_modules')
      .eq('id', tenantId)
      .maybeSingle();

    if (workspaceError) {
      console.warn('Subscription workspace metadata lookup failed:', workspaceError.message);
    }

    res.json({
      success: true,
      subscription: status,
      workspace: normalizeWorkspaceMetadata(workspaceRow as any),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/subscription/plans ──────────────────────────────────────────
router.get('/plans', async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('subscription_plans')
    .select('*')
    .eq('is_active', true)
    .order('price_etb');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, plans: data });
});

// ── POST /api/subscription/initiate-payment ───────────────────────────────
// Initiates a Chapa or Stripe checkout session
router.post('/initiate-payment', requireUser, requireScopedUser, async (req, res) => {
  try {
    const { tenantId, profileId } = req.user as any;
    const { tier, periodMonths = 1, currency = 'ETB', gateway = 'chapa', hubId } = req.body;

    if (!tier) return res.status(400).json({ error: 'tier is required' });

    const { data: plan } = await supabaseAdmin
      .from('subscription_plans')
      .select('*')
      .eq('tier', tier)
      .single();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const amount = currency === 'USD' ? plan.price_usd * periodMonths : plan.price_etb * periodMonths;
    const reference = `LNK-${Date.now().toString(36).toUpperCase()}`;

    // Record pending payment
    const { data: payment, error: pe } = await supabaseAdmin
      .from('payment_events')
      .insert({
        tenant_id: tenantId,
        hub_id: hubId || null,
        gateway,
        gateway_reference: reference,
        amount,
        currency,
        plan_tier: tier,
        period_months: periodMonths,
        period_start: new Date().toISOString(),
        period_end: new Date(Date.now() + periodMonths * 30 * 86_400_000).toISOString(),
        status: 'pending',
      })
      .select()
      .single();
    if (pe) throw pe;

    // Build gateway checkout URL
    let checkoutUrl = '';
    if (gateway === 'chapa') {
      const chapaKey = process.env.CHAPA_SECRET_KEY || '';
      const { data: tenant } = await supabaseAdmin.from('tenants').select('contact_email, name').eq('id', tenantId).single();
      const payload = {
        amount: amount.toFixed(2),
        currency,
        email: tenant?.contact_email || 'billing@linkhc.org',
        first_name: tenant?.name || 'Link HC',
        last_name: 'Clinic',
        tx_ref: reference,
        callback_url: `${process.env.BACKEND_URL || 'http://localhost:4000'}/api/webhook/chapa`,
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/subscribe/success?ref=${reference}`,
        customization: { title: 'Link HC Subscription', description: `${plan.display_name} — ${periodMonths} month(s)` },
      };
      const chapaRes = await fetch('https://api.chapa.co/v1/transaction/initialize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chapaKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const chapaData = await chapaRes.json() as any;
      checkoutUrl = chapaData?.data?.checkout_url || '';
    } else if (gateway === 'stripe') {
      // Stripe session creation (requires stripe npm package in production)
      checkoutUrl = `${process.env.FRONTEND_URL}/subscribe/stripe?ref=${reference}&amount=${amount}&currency=${currency}`;
    }

    res.json({ success: true, reference, paymentId: payment?.id, checkoutUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/subscription/manual-confirm ─────────────────────────────────
// For agent/cash/bank-transfer confirmations (admin or agent role only)
router.post('/manual-confirm', requireUser, requireScopedUser, async (req, res) => {
  try {
    const { profileId, role } = req.user as any;
    if (!['super_admin', 'admin', 'agent'].includes(role || '')) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const { paymentId, notes } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

    const { data: payment, error } = await supabaseAdmin
      .from('payment_events')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_by: profileId, notes })
      .eq('id', paymentId)
      .select()
      .single();
    if (error) throw error;

    // Activate subscription
    await activateSubscription(payment.tenant_id, payment.period_months, payment.plan_tier);
    invalidateSubscriptionCache(payment.tenant_id);

    // Issue license if hub-based
    let license = null;
    if (payment.hub_id) {
      license = await issueLicense({
        tenantId: payment.tenant_id,
        hubId: payment.hub_id,
        tier: payment.plan_tier,
        periodMonths: payment.period_months,
        paymentEventId: payment.id,
        deliveredVia: 'portal',
      });
    }

    res.json({ success: true, payment, license });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/subscription/license-public-key ─────────────────────────────
// Hub downloads this once to embed for offline validation
router.get('/license-public-key', async (_req, res) => {
  try {
    res.json({ success: true, publicKey: getPublicKey() });
  } catch {
    res.status(500).json({ error: 'Public key not configured' });
  }
});

// ── POST /api/subscription/activate-hub ──────────────────────────────────
// Hub calls this with its activation code + fingerprint
router.post('/activate-hub', async (req, res) => {
  try {
    const { activationCode, hubFingerprint } = req.body;
    if (!activationCode || !hubFingerprint) {
      return res.status(400).json({ error: 'activationCode and hubFingerprint required' });
    }
    const result = await activateHubLicense(activationCode, hubFingerprint);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/subscription/register-hub ──────────────────────────────────
// Called when a hub first comes online (or re-registers after moving)
router.post('/register-hub', requireUser, requireScopedUser, async (req, res) => {
  try {
    const { tenantId, facilityId: actorFacilityId, role } = req.user as any;
    const { hubFingerprint, facilityId, localIp, hubVersion, osPlatform } = req.body;
    if (!hubFingerprint) return res.status(400).json({ error: 'hubFingerprint required' });
    const resolvedFacilityId = (facilityId || actorFacilityId || '').trim();
    if (!resolvedFacilityId) {
      return res.status(400).json({ error: 'facilityId is required to register a hub' });
    }
    if (role !== 'super_admin' && actorFacilityId && resolvedFacilityId !== actorFacilityId) {
      return res.status(403).json({ error: 'Facility is outside your scope' });
    }

    const { data: existing } = await supabaseAdmin
      .from('hub_registrations')
      .select('id, tenant_id, facility_id')
      .eq('hub_fingerprint', hubFingerprint)
      .single();

    if (existing) {
      if (existing.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Hub fingerprint belongs to another tenant' });
      }
      // Update last seen
      await supabaseAdmin.from('hub_registrations').update({
        facility_id: existing.facility_id || resolvedFacilityId,
        local_ip: localIp,
        hub_version: hubVersion,
        os_platform: osPlatform,
        last_seen_at: new Date().toISOString(),
      }).eq('id', existing.id);
      return res.json({ success: true, hubId: existing.id, isNew: false });
    }

    const { data: hub, error } = await supabaseAdmin
      .from('hub_registrations')
      .insert({
        tenant_id: tenantId,
        facility_id: resolvedFacilityId,
        hub_fingerprint: hubFingerprint,
        local_ip: localIp,
        hub_version: hubVersion,
        os_platform: osPlatform,
        last_seen_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, hubId: hub.id, isNew: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/subscription/hub-session-token ─────────────────────────────
// Issue a short-lived signed token used by LAN clients/devices to sync
// against the local hub while internet to cloud auth is unavailable.
router.post('/hub-session-token', requireUser, requireScopedUser, async (req, res) => {
  try {
    const { tenantId, facilityId: actorFacilityId, role, profileId } = req.user as any;
    const { hubId, hubFingerprint, ttlHours } = req.body || {};
    if (!hubId && !hubFingerprint) {
      return res.status(400).json({ error: 'hubId or hubFingerprint is required' });
    }

    let query = supabaseAdmin
      .from('hub_registrations')
      .select('id, tenant_id, facility_id, is_active')
      .eq('tenant_id', tenantId)
      .limit(1);

    if (hubId) {
      query = query.eq('id', hubId);
    } else {
      query = query.eq('hub_fingerprint', String(hubFingerprint));
    }

    const { data: hub, error } = await query.maybeSingle();
    if (error) throw error;
    if (!hub) return res.status(404).json({ error: 'Hub registration not found' });
    if (hub.is_active === false) return res.status(403).json({ error: 'Hub is inactive' });
    if (!hub.facility_id) {
      return res.status(409).json({ error: 'Hub registration is missing facility scope' });
    }
    if (role !== 'super_admin' && actorFacilityId && hub.facility_id !== actorFacilityId) {
      return res.status(403).json({ error: 'Hub is outside your facility scope' });
    }

    const issued = issueHubSessionToken({
      hubId: hub.id,
      tenantId: hub.tenant_id,
      facilityId: hub.facility_id,
      profileId,
      ttlHours,
    });

    res.json({
      success: true,
      hubId: hub.id,
      facilityId: hub.facility_id,
      tenantId: hub.tenant_id,
      hubSessionToken: issued.token,
      expiresAt: issued.expiresAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/subscription/onboarding ─────────────────────────────────────
router.get('/onboarding', requireUser, requireScopedUser, async (req, res) => {
  const { tenantId } = req.user as any;
  const { data, error } = await supabaseAdmin.from('onboarding_checklist').select('*').eq('tenant_id', tenantId).single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json({ success: true, checklist: data || {} });
});

router.patch('/onboarding', requireUser, requireScopedUser, async (req, res) => {
  try {
    const { tenantId } = req.user as any;
    const allowed = ['step_add_facility','step_add_users','step_configure_services','step_run_test_patient','step_configure_billing'];
    const updates: Record<string, boolean> = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = Boolean(req.body[key]);
    }
    const allDone = allowed.every((k) => updates[k] === true || req.body[k] === true);
    if (allDone) updates['completed_at' as any] = new Date().toISOString() as any;

    const { data, error } = await supabaseAdmin.from('onboarding_checklist')
      .upsert({ tenant_id: tenantId, ...updates })
      .select()
      .single();
    if (error) throw error;

    if (allDone) {
      await supabaseAdmin.from('tenants').update({ onboarding_completed: true, onboarding_step: 5 }).eq('id', tenantId);
    }
    res.json({ success: true, checklist: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
