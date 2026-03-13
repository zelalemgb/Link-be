import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const authModule = await import('../../middleware/auth');
  const configModule = await import('../../config/supabase');
  return {
    requireUser: authModule.requireUser,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

const buildApp = (requireUser: any) => {
  const app = express();
  app.get('/secure', requireUser, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
};

test('requireUser returns 429 when auth provider is rate-limited', async () => {
  const { requireUser, supabaseAdmin } = await loadModules();
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: null },
        error: { status: 429, message: 'Too many requests' },
      }),
    };
    (supabaseAdmin as any).from = () => ({
      select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    });

    const app = buildApp(requireUser);
    const response = await request(app)
      .get('/secure')
      .set('authorization', 'Bearer valid-token');

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, {
      error: 'Auth service rate limit reached. Please try again later.',
    });
  } finally {
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('requireUser returns 503 when auth provider is unavailable', async () => {
  const { requireUser, supabaseAdmin } = await loadModules();
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: null },
        error: { status: 503, message: 'upstream unavailable' },
      }),
    };
    (supabaseAdmin as any).from = () => ({
      select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    });

    const app = buildApp(requireUser);
    const response = await request(app)
      .get('/secure')
      .set('authorization', 'Bearer valid-token');

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: 'Authentication service temporarily unavailable. Please retry.',
    });
  } finally {
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('requireUser falls back to a recently validated token when auth provider becomes unavailable', async () => {
  const { requireUser, supabaseAdmin } = await loadModules();
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;

  try {
    let authCalls = 0;
    (supabaseAdmin as any).auth = {
      getUser: async () => {
        authCalls += 1;
        if (authCalls === 1) {
          return {
            data: {
              user: {
                id: 'auth-user-1',
                email: 'root@linkhc.org',
              },
            },
            error: null,
          };
        }

        return {
          data: { user: null },
          error: { status: 503, message: 'upstream unavailable' },
        };
      },
    };

    (supabaseAdmin as any).from = () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            maybeSingle: async () => ({
              data: {
                id: 'profile-1',
                tenant_id: 'tenant-1',
                facility_id: 'facility-1',
                user_role: 'super_admin',
              },
              error: null,
            }),
          }),
        }),
      }),
    });

    const app = buildApp(requireUser);
    const token = [
      'header',
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url'),
      'signature',
    ].join('.');

    const firstResponse = await request(app)
      .get('/secure')
      .set('authorization', `Bearer ${token}`);

    const secondResponse = await request(app)
      .get('/secure')
      .set('authorization', `Bearer ${token}`);

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(secondResponse.body, { ok: true });
  } finally {
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('requireUser accepts a locally verified Supabase JWT when auth provider is unavailable', async () => {
  const { requireUser, supabaseAdmin } = await loadModules();
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;
  const originalFetch = global.fetch;

  try {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const kid = 'test-supabase-kid';
    const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        }
      )) as typeof fetch;

    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: null },
        error: { status: 503, message: 'upstream unavailable' },
      }),
    };

    (supabaseAdmin as any).from = () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            maybeSingle: async () => ({
              data: {
                id: 'profile-1',
                tenant_id: 'tenant-1',
                facility_id: 'facility-1',
                user_role: 'super_admin',
              },
              error: null,
            }),
          }),
        }),
      }),
    });

    const token = jwt.sign(
      {
        email: 'root@linkhc.org',
        role: 'authenticated',
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: kid,
        issuer: `${process.env.SUPABASE_URL}/auth/v1`,
        subject: 'auth-user-jwks',
        expiresIn: '10m',
      }
    );

    const app = buildApp(requireUser);
    const response = await request(app)
      .get('/secure')
      .set('authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  } finally {
    global.fetch = originalFetch;
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});
