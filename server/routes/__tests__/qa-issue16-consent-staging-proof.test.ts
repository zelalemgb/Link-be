import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

type JsonBody = Record<string, unknown> | null;

type PatientAuthContext =
  | { mode: 'bearer'; token: string }
  | { mode: 'cookie'; cookieHeader: string; csrfToken: string };

const CONSENT_TYPE = 'records_access';
const STAGING_RUN_ENABLED = process.env.RUN_STAGING_CONSENT_QA === '1';

const requireEnv = (name: string) => (process.env[name] || '').trim();

const normalizeApiBaseUrl = (value: string) => {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
};

const parseBody = async (response: Response): Promise<JsonBody> => {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
};

const getSetCookies = (response: Response): string[] => {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
};

const extractCookieValue = (cookies: string[], cookieName: string) => {
  const prefix = `${cookieName}=`;
  for (const entry of cookies) {
    const firstPart = entry.split(';', 1)[0] || '';
    if (firstPart.startsWith(prefix)) {
      return firstPart.slice(prefix.length);
    }
  }
  return '';
};

const resolvePatientAuth = async (apiBaseUrl: string): Promise<PatientAuthContext> => {
  const stagedBearer = requireEnv('STAGING_PATIENT_SESSION_TOKEN');
  if (stagedBearer) {
    return { mode: 'bearer', token: stagedBearer };
  }

  const phoneNumber = requireEnv('STAGING_PATIENT_PHONE');
  assert.ok(phoneNumber, 'Missing STAGING_PATIENT_PHONE when STAGING_PATIENT_SESSION_TOKEN is not set');

  const response = await fetch(`${apiBaseUrl}/patient-auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
  const body = await parseBody(response);

  if (response.status === 403) {
    assert.fail(
      `Staging patient dev-login is disabled. Set STAGING_PATIENT_SESSION_TOKEN and rerun. Response: ${JSON.stringify(body)}`
    );
  }
  assert.ok(
    response.ok,
    `Failed to establish patient auth context via dev-login: ${response.status} ${JSON.stringify(body)}`
  );

  const cookies = getSetCookies(response);
  const patientSession = extractCookieValue(cookies, 'patient_session');
  const patientCsrf = extractCookieValue(cookies, 'patient_csrf');
  assert.ok(patientSession, 'Missing patient_session cookie from dev-login response');
  assert.ok(patientCsrf, 'Missing patient_csrf cookie from dev-login response');

  return {
    mode: 'cookie',
    cookieHeader: `patient_session=${patientSession}; patient_csrf=${patientCsrf}`,
    csrfToken: patientCsrf,
  };
};

const resolveProviderToken = async () => {
  const stagedToken = requireEnv('STAGING_PROVIDER_BEARER_TOKEN');
  if (stagedToken) return stagedToken;

  const supabaseUrl = requireEnv('STAGING_SUPABASE_URL');
  const supabaseAnonKey = requireEnv('STAGING_SUPABASE_ANON_KEY');
  const providerEmail = requireEnv('STAGING_PROVIDER_EMAIL');
  const providerPassword = requireEnv('STAGING_PROVIDER_PASSWORD');

  assert.ok(
    supabaseUrl && supabaseAnonKey && providerEmail && providerPassword,
    [
      'Missing provider auth inputs.',
      'Provide STAGING_PROVIDER_BEARER_TOKEN or all of:',
      'STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY, STAGING_PROVIDER_EMAIL, STAGING_PROVIDER_PASSWORD',
    ].join(' ')
  );

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: providerEmail,
    password: providerPassword,
  });
  assert.ok(!error, `Failed provider sign-in for staging proof: ${error?.message || 'unknown error'}`);
  const token = data.session?.access_token || '';
  assert.ok(token, 'Missing provider access token after sign-in');
  return token;
};

const buildPatientHeaders = (auth: PatientAuthContext, includeCsrf = false) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (auth.mode === 'bearer') {
    headers.authorization = `Bearer ${auth.token}`;
    return headers;
  }

  headers.cookie = auth.cookieHeader;
  if (includeCsrf) {
    headers['x-csrf-token'] = auth.csrfToken;
  }
  return headers;
};

const proofTest = STAGING_RUN_ENABLED ? test : test.skip;

proofTest(
  'STG-QA-CONSENT-001 real backend consent lifecycle (deny -> grant -> allow -> revoke -> deny)',
  { timeout: 180_000 },
  async () => {
    const apiBaseRaw = requireEnv('STAGING_API_BASE_URL');
    const facilityId = requireEnv('STAGING_FACILITY_ID');
    const patientId = requireEnv('STAGING_PATIENT_ID');

    assert.ok(apiBaseRaw, 'Missing STAGING_API_BASE_URL');
    assert.ok(facilityId, 'Missing STAGING_FACILITY_ID');
    assert.ok(patientId, 'Missing STAGING_PATIENT_ID');

    const apiBaseUrl = normalizeApiBaseUrl(apiBaseRaw);
    const providerToken = await resolveProviderToken();
    const patientAuth = await resolvePatientAuth(apiBaseUrl);
    const runId = `stg-consent-${Date.now()}`;

    const providerRead = async () => {
      const response = await fetch(`${apiBaseUrl}/patients/${patientId}/visits/history?limit=1`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${providerToken}`,
          accept: 'application/json',
        },
      });
      return { status: response.status, body: await parseBody(response) };
    };

    const patientPost = async (path: string, payload: Record<string, unknown>) => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: 'POST',
        headers: buildPatientHeaders(patientAuth, true),
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await parseBody(response) };
    };

    const baselineRevoke = await patientPost('/patient-portal/consents/revoke', {
      facilityId,
      consentType: CONSENT_TYPE,
      acknowledged: true,
      reason: `QA baseline reset ${runId}`,
      metadata: { runId, stage: 'baseline-revoke' },
    });

    assert.ok(
      baselineRevoke.status === 200 ||
        (baselineRevoke.status === 409 && String((baselineRevoke.body || {}).code) === 'CONFLICT_CONSENT_ACCESS_REVOKED'),
      `Baseline revoke expected 200 or already-revoked 409, got ${baselineRevoke.status} ${JSON.stringify(baselineRevoke.body)}`
    );

    const beforeGrant = await providerRead();
    assert.ok(
      beforeGrant.status === 403 || beforeGrant.status === 409,
      `Provider read must be denied before grant, got ${beforeGrant.status} ${JSON.stringify(beforeGrant.body)}`
    );

    const grant = await patientPost('/patient-portal/consents/grant', {
      facilityId,
      consentType: CONSENT_TYPE,
      purpose: 'QA staging proof',
      comprehensionText:
        'I understand this grants the selected care team access to my records for treatment, care coordination, and continuity.',
      comprehensionLanguage: 'en-US',
      comprehensionRecordedAt: new Date().toISOString(),
      uiLanguage: 'en-US',
      comprehensionConfirmed: true,
      highRiskOverride: true,
      overrideReason: 'Provider read staging proof requires explicit controlled override.',
      metadata: { runId, stage: 'grant' },
    });

    assert.ok(
      grant.status === 200 || grant.status === 201,
      `Grant expected 200/201, got ${grant.status} ${JSON.stringify(grant.body)}`
    );
    assert.equal(
      Boolean((grant.body as Record<string, any> | null)?.consent?.isActive),
      true,
      `Grant response must return active consent: ${JSON.stringify(grant.body)}`
    );

    const afterGrant = await providerRead();
    assert.equal(
      afterGrant.status,
      200,
      `Provider read must be allowed after grant, got ${afterGrant.status} ${JSON.stringify(afterGrant.body)}`
    );

    const revoke = await patientPost('/patient-portal/consents/revoke', {
      facilityId,
      consentType: CONSENT_TYPE,
      acknowledged: true,
      reason: `QA revoke ${runId}`,
      metadata: { runId, stage: 'revoke' },
    });

    assert.equal(revoke.status, 200, `Revoke expected 200, got ${revoke.status} ${JSON.stringify(revoke.body)}`);

    const afterRevoke = await providerRead();
    assert.ok(
      afterRevoke.status === 403 || afterRevoke.status === 409,
      `Provider read must be denied immediately after revoke, got ${afterRevoke.status} ${JSON.stringify(afterRevoke.body)}`
    );

    const denialCodes = new Set(['PERM_PHI_CONSENT_REQUIRED', 'CONFLICT_CONSENT_ACCESS_REVOKED']);
    const beforeCode = String((beforeGrant.body || {}).code || '');
    const afterCode = String((afterRevoke.body || {}).code || '');
    assert.ok(
      denialCodes.has(beforeCode),
      `Unexpected pre-grant denial code: ${beforeCode || '<missing>'} payload=${JSON.stringify(beforeGrant.body)}`
    );
    assert.ok(
      denialCodes.has(afterCode),
      `Unexpected post-revoke denial code: ${afterCode || '<missing>'} payload=${JSON.stringify(afterRevoke.body)}`
    );
  }
);
