import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

type QueryResult = {
  data: any;
  error: any;
  count?: number | null;
};

const createQuery = (resolved: QueryResult) => {
  const query: any = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    maybeSingle: async () => ({ ...resolved }),
    single: async () => ({ ...resolved }),
    limit() {
      return query;
    },
    order() {
      return query;
    },
    range() {
      return query;
    },
    or() {
      return query;
    },
    in() {
      return query;
    },
    gte() {
      return query;
    },
    lt() {
      return query;
    },
    update() {
      return query;
    },
    insert() {
      return query;
    },
    delete() {
      return query;
    },
    then(onFulfilled: any, onRejected: any) {
      return Promise.resolve({ ...resolved }).then(onFulfilled, onRejected);
    },
  };

  return query;
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const indexModule = await import('../../index');
  const configModule = await import('../../config/supabase');
  return {
    app: indexModule.app,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

const installRestrictedTenantStub = (supabaseAdmin: any, role: string = 'receptionist') => {
  const originalAuth = supabaseAdmin.auth;
  const originalFrom = supabaseAdmin.from;

  supabaseAdmin.auth = {
    getUser: async () => ({
      data: { user: { id: '11111111-1111-1111-1111-111111111111' } },
      error: null,
    }),
  };

  supabaseAdmin.from = (table: string) => {
    if (table === 'users') {
      return createQuery({
        data: {
          id: '22222222-2222-4222-8222-222222222222',
          tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          facility_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          user_role: role,
        },
        error: null,
      });
    }

    if (table === 'tenants') {
      return createQuery({
        data: {
          subscription_status: 'restricted',
          subscription_tier: 'health_centre',
          trial_started_at: null,
          trial_expires_at: null,
          subscription_expires_at: null,
          grace_expires_at: null,
          workspace_type: 'clinic',
          setup_mode: 'standard',
          team_mode: 'shared',
          enabled_modules: [],
        },
        error: null,
      });
    }

    if (table === 'subscription_plans') {
      return createQuery({
        data: {
          features: {},
        },
        error: null,
      });
    }

    if (table === 'patients') {
      return createQuery({
        data: [],
        error: null,
      });
    }

    return createQuery({
      data: [],
      error: null,
    });
  };

  return () => {
    supabaseAdmin.auth = originalAuth;
    supabaseAdmin.from = originalFrom;
  };
};

test('read-only subscription blocks protected patient intake writes on the real app', async () => {
  const { app, supabaseAdmin } = await loadModules();
  const restore = installRestrictedTenantStub(supabaseAdmin);

  try {
    const response = await request(app)
      .post('/api/patients/register-intake')
      .set('authorization', 'Bearer valid-token')
      .send({});

    assert.equal(response.status, 402, JSON.stringify(response.body));
    assert.equal(response.body?.error, 'subscription_required');
  } finally {
    restore();
  }
});

test('read-only subscription still allows protected GET reads', async () => {
  const { app, supabaseAdmin } = await loadModules();
  const restore = installRestrictedTenantStub(supabaseAdmin);

  try {
    const response = await request(app)
      .get('/api/reception/search?q=test')
      .set('authorization', 'Bearer valid-token');

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { visits: [] });
  } finally {
    restore();
  }
});

test('subscription routes bypass read-only enforcement for authenticated actors', async () => {
  const { app, supabaseAdmin } = await loadModules();
  const restore = installRestrictedTenantStub(supabaseAdmin, 'admin');

  try {
    const response = await request(app)
      .post('/api/subscription/manual-confirm')
      .set('authorization', 'Bearer valid-token')
      .send({});

    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body?.error, 'paymentId required');
  } finally {
    restore();
  }
});
