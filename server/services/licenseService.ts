/**
 * License Key Service
 *
 * Issues and validates RSA-signed JWT license keys for offline hub operation.
 * The hub validates licenses locally using an embedded public key.
 * No internet required for validation.
 *
 * Key format: standard JWT (RS256)
 * Short code: LNKH-XXXX-XXXX-XXXX (used for SMS/phone delivery)
 */

import * as crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase';

// RSA key pair — loaded from environment
// Generate: openssl genrsa -out license_private.pem 2048
//           openssl rsa -in license_private.pem -pubout -out license_public.pem
function getPrivateKey(): string {
  const key = process.env.LICENSE_RSA_PRIVATE_KEY;
  if (!key) throw new Error('LICENSE_RSA_PRIVATE_KEY not set');
  return key.replace(/\\n/g, '\n');
}

export function getPublicKey(): string {
  const key = process.env.LICENSE_RSA_PUBLIC_KEY;
  if (!key) throw new Error('LICENSE_RSA_PUBLIC_KEY not set');
  return key.replace(/\\n/g, '\n');
}

// ── JWT helpers (no external dependency — use Node crypto) ────────────────

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJwt(payload: object, privateKey: string): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body   = base64url(JSON.stringify(payload));
  const signing = `${header}.${body}`;
  const sig = crypto.sign('sha256', Buffer.from(signing), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  return `${signing}.${base64url(sig)}`;
}

export function verifyJwt(token: string, publicKey: string): LicensePayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const signing = `${parts[0]}.${parts[1]}`;
    const sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const valid = crypto.verify('sha256', Buffer.from(signing), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
    if (!valid) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // expired
    return payload as LicensePayload;
  } catch {
    return null;
  }
}

// ── Short activation code ─────────────────────────────────────────────────

function generateActivationCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  const groups = [4, 4, 4, 4];
  return groups
    .map((len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join(''))
    .join('-');
}

// ── Types ─────────────────────────────────────────────────────────────────

export type LicensePayload = {
  sub: string;         // hub_id
  tid: string;         // tenant_id
  tier: string;
  iat: number;
  exp: number;
  features: Record<string, boolean>;
  emergency_unlocks_remaining: number;
};

export type IssuedLicense = {
  jwt: string;
  activationCode: string;
  expiresAt: string;
  hubId: string;
};

export type HubSessionPayload = {
  sub: string; // hub_id
  tid: string; // tenant_id
  fid: string; // facility_id
  pid?: string; // public.users.id who issued the token
  typ: 'hub_sync';
  iat: number;
  exp: number;
};

export type IssuedHubSessionToken = {
  token: string;
  expiresAt: string;
  hubId: string;
  facilityId: string;
  tenantId: string;
};

/**
 * Issue a short-lived hub session token used by LAN clients/devices to sync
 * against a local Link Hub when upstream internet is unavailable.
 */
export const issueHubSessionToken = (params: {
  hubId: string;
  tenantId: string;
  facilityId: string;
  profileId?: string;
  ttlHours?: number;
}): IssuedHubSessionToken => {
  const ttlHoursRaw = Number(params.ttlHours ?? 24 * 7);
  const ttlHours = Number.isFinite(ttlHoursRaw) ? Math.min(Math.max(ttlHoursRaw, 1), 24 * 30) : 24 * 7;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const payload: HubSessionPayload = {
    sub: params.hubId,
    tid: params.tenantId,
    fid: params.facilityId,
    ...(params.profileId ? { pid: params.profileId } : {}),
    typ: 'hub_sync',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };

  const token = signJwt(payload, getPrivateKey());
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    hubId: params.hubId,
    facilityId: params.facilityId,
    tenantId: params.tenantId,
  };
};

// ── Issue a license key ───────────────────────────────────────────────────

export async function issueLicense(params: {
  tenantId: string;
  hubId: string;
  tier: string;
  periodMonths: number;
  paymentEventId?: string;
  deliveredVia?: string;
}): Promise<IssuedLicense> {
  const { tenantId, hubId, tier, periodMonths, paymentEventId, deliveredVia } = params;

  // Fetch plan features
  const { data: plan } = await supabaseAdmin
    .from('subscription_plans')
    .select('features')
    .eq('tier', tier)
    .single();

  const expiresAt = new Date(Date.now() + periodMonths * 30 * 86_400_000);
  const payload: LicensePayload = {
    sub: hubId,
    tid: tenantId,
    tier,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
    features: plan?.features || {},
    emergency_unlocks_remaining: 3,
  };

  const jwt = signJwt(payload, getPrivateKey());

  // Generate unique activation code
  let activationCode = '';
  let attempts = 0;
  while (attempts < 10) {
    activationCode = generateActivationCode();
    const { data: existing } = await supabaseAdmin
      .from('license_keys')
      .select('id')
      .eq('activation_code', activationCode)
      .single();
    if (!existing) break;
    attempts++;
  }

  // Revoke any previous active license for this hub
  await supabaseAdmin
    .from('license_keys')
    .update({ is_revoked: true, revoked_at: new Date().toISOString(), revoked_reason: 'superseded_by_renewal' })
    .eq('hub_id', hubId)
    .eq('is_revoked', false);

  // Store new license
  const { error } = await supabaseAdmin.from('license_keys').insert({
    tenant_id: tenantId,
    hub_id: hubId,
    license_jwt: jwt,
    activation_code: activationCode,
    tier,
    expires_at: expiresAt.toISOString(),
    payment_event_id: paymentEventId || null,
    delivered_via: deliveredVia || null,
  });

  if (error) throw error;

  return { jwt, activationCode, expiresAt: expiresAt.toISOString(), hubId };
}

// ── Validate and record hub activation ───────────────────────────────────

export async function activateHubLicense(activationCode: string, hubFingerprint: string): Promise<{ valid: boolean; payload?: LicensePayload; message: string }> {
  const { data: license } = await supabaseAdmin
    .from('license_keys')
    .select('*')
    .eq('activation_code', activationCode.toUpperCase().replace(/\s/g, ''))
    .single();

  if (!license) return { valid: false, message: 'Activation code not found.' };
  if (license.is_revoked) return { valid: false, message: 'This activation code has been revoked.' };
  if (new Date(license.expires_at) < new Date()) return { valid: false, message: 'This license has expired. Please renew.' };

  // Verify JWT signature
  const payload = verifyJwt(license.license_jwt, getPublicKey());
  if (!payload) return { valid: false, message: 'License signature invalid.' };

  // Verify hub fingerprint matches
  const { data: hub } = await supabaseAdmin
    .from('hub_registrations')
    .select('hub_fingerprint')
    .eq('id', license.hub_id)
    .single();

  if (hub && hub.hub_fingerprint !== hubFingerprint) {
    return { valid: false, message: 'License is registered to a different hub.' };
  }

  // Record activation
  await supabaseAdmin
    .from('license_keys')
    .update({
      activation_count: license.activation_count + 1,
      last_activated_at: new Date().toISOString(),
      delivered_at: license.delivered_at || new Date().toISOString(),
    })
    .eq('id', license.id);

  return { valid: true, payload, message: 'License activated successfully.' };
}
