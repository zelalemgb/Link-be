import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import * as crypto from 'node:crypto';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const routeModule = await import('../subscription');
  const configModule = await import('../../config/supabase');
  return {
    subscriptionRouter: routeModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('subscription hub-session-token issues signed hub token for in-scope registered hub', async () => {
  const { subscriptionRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalPrivate = process.env.LICENSE_RSA_PRIVATE_KEY;
  const originalPublic = process.env.LICENSE_RSA_PUBLIC_KEY;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const hubId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const profileId = '99999999-9999-4999-8999-999999999999';

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.LICENSE_RSA_PRIVATE_KEY = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString()
    .replace(/\n/g, '\\n');
  process.env.LICENSE_RSA_PUBLIC_KEY = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
    .replace(/\n/g, '\\n');

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: '11111111-1111-1111-1111-111111111111' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: Record<string, any> = {};
      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: any) {
          state[column] = value;
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: {
                id: profileId,
                tenant_id: tenantId,
                facility_id: facilityId,
                user_role: 'doctor',
              },
              error: null,
            };
          }
          if (table === 'hub_registrations') {
            return {
              data: {
                id: hubId,
                tenant_id: tenantId,
                facility_id: facilityId,
                is_active: true,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/subscription', subscriptionRouter);

    const response = await request(app)
      .post('/api/subscription/hub-session-token')
      .set('authorization', 'Bearer valid-token')
      .send({
        hubId,
        ttlHours: 12,
      });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body?.success, true);
    assert.equal(response.body?.hubId, hubId);
    assert.equal(response.body?.tenantId, tenantId);
    assert.equal(response.body?.facilityId, facilityId);
    assert.equal(typeof response.body?.hubSessionToken, 'string');
    assert.equal(String(response.body?.hubSessionToken || '').split('.').length, 3);
    assert.equal(typeof response.body?.expiresAt, 'string');
    const payload = JSON.parse(
      Buffer.from(String(response.body?.hubSessionToken || '').split('.')[1] || '', 'base64url').toString('utf8')
    );
    assert.equal(payload?.pid, profileId);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    process.env.LICENSE_RSA_PRIVATE_KEY = originalPrivate;
    process.env.LICENSE_RSA_PUBLIC_KEY = originalPublic;
  }
});

test('subscription register-hub defaults facilityId to actor scope when omitted', async () => {
  const { subscriptionRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const hubId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const hubFingerprint = 'hub-fingerprint-test-001';
  const profileId = '99999999-9999-4999-8999-999999999999';

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: '11111111-1111-1111-1111-111111111111' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: Record<string, any> = { operation: 'select', insertPayload: null };
      const query: any = {
        select() {
          if (state.operation !== 'insert') {
            state.operation = 'select';
          }
          return query;
        },
        eq(column: string, value: any) {
          state[column] = value;
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: {
                id: profileId,
                tenant_id: tenantId,
                facility_id: facilityId,
                user_role: 'doctor',
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'hub_registrations' && state.operation === 'select') {
            return { data: null, error: null };
          }
          if (table === 'hub_registrations' && state.operation === 'insert') {
            return {
              data: {
                id: hubId,
                tenant_id: tenantId,
                facility_id: state.insertPayload?.facility_id || null,
                hub_fingerprint: hubFingerprint,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        insert(payload: any) {
          state.operation = 'insert';
          state.insertPayload = payload;
          return query;
        },
      };
      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/subscription', subscriptionRouter);

    const response = await request(app)
      .post('/api/subscription/register-hub')
      .set('authorization', 'Bearer valid-token')
      .send({
        hubFingerprint,
        localIp: '192.168.88.1',
        hubVersion: 'sim-1',
        osPlatform: 'linux',
      });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body?.success, true);
    assert.equal(response.body?.hubId, hubId);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});
