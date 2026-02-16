import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const staffRouteModule = await import('../staff');
  const configModule = await import('../../config/supabase');
  return {
    staffRouter: staffRouteModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('staff approve route surfaces transactional RPC failure with stable contract and no fallback writes', async () => {
  const { staffRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalRpc = (supabaseAdmin as any).rpc;
  const originalAuth = (supabaseAdmin as any).auth;

  let writeCalls = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: {
          user: {
            id: '11111111-1111-1111-1111-111111111111',
          },
        },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: {
                id: 'profile-1',
                tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                facility_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                user_role: 'clinic_admin',
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        insert() {
          writeCalls += 1;
          return query;
        },
        update() {
          writeCalls += 1;
          return query;
        },
        upsert() {
          writeCalls += 1;
          return query;
        },
        delete() {
          writeCalls += 1;
          return query;
        },
      };

      return query;
    };

    (supabaseAdmin as any).rpc = async (fn: string, payload: Record<string, any>) => {
      assert.equal(fn, 'backend_approve_staff_registration_request');
      assert.equal(payload.p_actor_role, 'clinic_admin');
      assert.equal(payload.p_request_id, '33333333-3333-4333-8333-333333333333');
      return {
        data: null,
        error: {
          message: 'DEBUG_APPROVAL_FAILURE_AFTER_ROLE_UPSERT',
        },
      };
    };

    const app = express();
    app.use(express.json());
    app.use('/api/staff', staffRouter);

    const response = await request(app)
      .post('/api/staff/admin/requests/33333333-3333-4333-8333-333333333333/approve')
      .set('authorization', 'Bearer valid-token')
      .send({ reason: 'Approve for onboarding' });

    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'CONFLICT_REQUEST_APPROVAL_FAILED');
    assert.equal(response.body.message, 'DEBUG_APPROVAL_FAILURE_AFTER_ROLE_UPSERT');
    assert.equal(writeCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).rpc = originalRpc;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('staff approve route maps audit durability rpc failure to stable contract code', async () => {
  const { staffRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalRpc = (supabaseAdmin as any).rpc;
  const originalAuth = (supabaseAdmin as any).auth;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: {
          user: {
            id: '11111111-1111-1111-1111-111111111111',
          },
        },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: {
                id: 'profile-1',
                tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                facility_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                user_role: 'clinic_admin',
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };

      return query;
    };

    (supabaseAdmin as any).rpc = async () => ({
      data: null,
      error: {
        message: 'AUDIT_DURABILITY_FAILURE',
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/api/staff', staffRouter);

    const response = await request(app)
      .post('/api/staff/admin/requests/33333333-3333-4333-8333-333333333333/approve')
      .set('authorization', 'Bearer valid-token')
      .send({ reason: 'Approve for onboarding' });

    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
    assert.equal(response.body.message, 'Audit durability requirement failed');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).rpc = originalRpc;
    (supabaseAdmin as any).auth = originalAuth;
  }
});
