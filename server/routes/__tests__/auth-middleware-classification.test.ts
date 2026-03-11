import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

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
