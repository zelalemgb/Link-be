/**
 * Subscription Service
 * Manages trial lifecycle, subscription status, and grace periods.
 * Called by middleware on every request and by scheduled reminder jobs.
 */

import { supabaseAdmin } from '../config/supabase';

export type AccessLevel = 'full' | 'grace' | 'read_only';

export type SubscriptionStatus = {
  accessLevel: AccessLevel;
  status: string;
  tier: string;
  trialExpiresAt: string | null;
  subscriptionExpiresAt: string | null;
  graceExpiresAt: string | null;
  daysRemaining: number | null;
  isInTrial: boolean;
  trialDaysUsed: number | null;
  planFeatures: Record<string, boolean>;
  message: string | null;
};

const GRACE_PERIOD_DAYS = 14;
const TRIAL_DAYS = 30;

export async function getSubscriptionStatus(tenantId: string): Promise<SubscriptionStatus> {
  const { data: tenant, error } = await supabaseAdmin
    .from('tenants')
    .select('subscription_status, subscription_tier, trial_started_at, trial_expires_at, subscription_expires_at, grace_expires_at')
    .eq('id', tenantId)
    .single();

  if (error || !tenant) {
    return buildReadOnly('Tenant not found', null, null);
  }

  const now = new Date();
  const trialExp = tenant.trial_expires_at ? new Date(tenant.trial_expires_at) : null;
  const subExp = tenant.subscription_expires_at ? new Date(tenant.subscription_expires_at) : null;
  const graceExp = tenant.grace_expires_at ? new Date(tenant.grace_expires_at) : null;
  const trialStart = tenant.trial_started_at ? new Date(tenant.trial_started_at) : null;

  // Fetch plan features
  const { data: plan } = await supabaseAdmin
    .from('subscription_plans')
    .select('features')
    .eq('tier', tenant.subscription_tier || 'health_centre')
    .single();
  const planFeatures: Record<string, boolean> = plan?.features || {};

  // Active paid subscription
  if (tenant.subscription_status === 'active' && subExp && subExp > now) {
    const days = Math.ceil((subExp.getTime() - now.getTime()) / 86_400_000);
    return {
      accessLevel: 'full',
      status: 'active',
      tier: tenant.subscription_tier,
      trialExpiresAt: null,
      subscriptionExpiresAt: tenant.subscription_expires_at,
      graceExpiresAt: null,
      daysRemaining: days,
      isInTrial: false,
      trialDaysUsed: null,
      planFeatures,
      message: days <= 14 ? `Subscription renews in ${days} days` : null,
    };
  }

  // Active trial
  if (tenant.subscription_status === 'trial' && trialExp && trialExp > now) {
    const days = Math.ceil((trialExp.getTime() - now.getTime()) / 86_400_000);
    const used = trialStart ? Math.floor((now.getTime() - trialStart.getTime()) / 86_400_000) : null;
    return {
      accessLevel: 'full',
      status: 'trial',
      tier: tenant.subscription_tier,
      trialExpiresAt: tenant.trial_expires_at,
      subscriptionExpiresAt: null,
      graceExpiresAt: null,
      daysRemaining: days,
      isInTrial: true,
      trialDaysUsed: used,
      planFeatures,
      message: `Free trial — ${days} day${days !== 1 ? 's' : ''} remaining`,
    };
  }

  // Grace period
  if (tenant.subscription_status === 'grace' && graceExp && graceExp > now) {
    const days = Math.ceil((graceExp.getTime() - now.getTime()) / 86_400_000);
    return {
      accessLevel: 'grace',
      status: 'grace',
      tier: tenant.subscription_tier,
      trialExpiresAt: null,
      subscriptionExpiresAt: null,
      graceExpiresAt: tenant.grace_expires_at,
      daysRemaining: days,
      isInTrial: false,
      trialDaysUsed: null,
      planFeatures,
      message: `Grace period — subscribe within ${days} day${days !== 1 ? 's' : ''} to keep write access`,
    };
  }

  return buildReadOnly(
    'Subscription expired. Your data is safe — subscribe to restore write access.',
    tenant.subscription_tier,
    planFeatures
  );
}

function buildReadOnly(message: string, tier: string | null, features: Record<string, boolean> | null): SubscriptionStatus {
  return {
    accessLevel: 'read_only',
    status: 'restricted',
    tier: tier || 'health_centre',
    trialExpiresAt: null,
    subscriptionExpiresAt: null,
    graceExpiresAt: null,
    daysRemaining: 0,
    isInTrial: false,
    trialDaysUsed: null,
    planFeatures: features || {},
    message,
  };
}

/**
 * Transition a tenant from trial → grace when trial expires.
 * Called by the nightly check-trial-expiry edge function.
 */
export async function transitionExpiredTrials(): Promise<number> {
  const now = new Date().toISOString();
  const graceExpires = new Date(Date.now() + GRACE_PERIOD_DAYS * 86_400_000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .update({ subscription_status: 'grace', grace_expires_at: graceExpires })
    .eq('subscription_status', 'trial')
    .lt('trial_expires_at', now)
    .select('id');

  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Transition grace → restricted when grace period expires.
 */
export async function transitionExpiredGrace(): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .update({ subscription_status: 'restricted' })
    .eq('subscription_status', 'grace')
    .lt('grace_expires_at', now)
    .select('id');

  if (error) throw error;
  return data?.length ?? 0;
}

/**
 * Activate a subscription after confirmed payment.
 */
export async function activateSubscription(
  tenantId: string,
  periodMonths: number,
  tier: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + periodMonths * 30 * 86_400_000).toISOString();
  const { error } = await supabaseAdmin
    .from('tenants')
    .update({
      subscription_status: 'active',
      subscription_tier: tier,
      subscription_expires_at: expiresAt,
      grace_expires_at: null,
    })
    .eq('id', tenantId);
  if (error) throw error;
}

/**
 * Provision a fresh tenant with a 30-day trial.
 */
export async function provisionTrial(tenantId: string, tier: string = 'health_centre'): Promise<void> {
  const trialStarted = new Date().toISOString();
  const trialExpires = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
  const { error } = await supabaseAdmin
    .from('tenants')
    .update({
      subscription_status: 'trial',
      subscription_tier: tier,
      trial_started_at: trialStarted,
      trial_expires_at: trialExpires,
    })
    .eq('id', tenantId);
  if (error) throw error;
}
