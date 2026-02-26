import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

type QueryState = {
  operation: 'select' | 'insert' | 'update' | 'delete';
  filters: Record<string, unknown>;
  payload?: any;
};

type TableHandler = {
  maybeSingle?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
  single?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
};

const createFromStub = (handlers: Record<string, TableHandler>) => {
  return (table: string) => {
    const state: QueryState = {
      operation: 'select',
      filters: {},
    };
    const handler = handlers[table] || {};

    const query: any = {
      select() {
        return query;
      },
      eq(column: string, value: unknown) {
        state.filters[column] = value;
        return query;
      },
      is(column: string, value: unknown) {
        state.filters[column] = value;
        return query;
      },
      in(column: string, value: unknown) {
        state.filters[column] = value;
        return query;
      },
      order() {
        return query;
      },
      limit() {
        return query;
      },
      insert(payload: any) {
        state.operation = 'insert';
        state.payload = payload;
        return query;
      },
      update(payload: any) {
        state.operation = 'update';
        state.payload = payload;
        return query;
      },
      delete() {
        state.operation = 'delete';
        return query;
      },
      maybeSingle: async () => (handler.maybeSingle ? handler.maybeSingle(state) : { data: null, error: null }),
      single: async () => (handler.single ? handler.single(state) : { data: null, error: null }),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
    };

    return query;
  };
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const inventoryRouteModule = await import('../inventory');
  const configModule = await import('../../config/supabase');
  return {
    inventoryRouter: inventoryRouteModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

const buildApp = (inventoryRouter: any) => {
  const app = express();
  app.use(express.json());
  app.use('/api/inventory', inventoryRouter);
  return app;
};

const baseProfile = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  facility_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  user_role: 'pharmacist',
};

test('inventory receiving invoice create fails closed when strict audit durability fails', async () => {
  const { inventoryRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'audit_log') {
        return {
          insert: async () => ({ data: null, error: { message: 'audit write failed' } }),
        };
      }
      if (table === 'outbox_events') {
        return {
          insert: async () => ({ data: null, error: { message: 'outbox write failed' } }),
        };
      }

      return createFromStub({
        users: {
          maybeSingle: () => ({ data: baseProfile, error: null }),
        },
        receiving_invoices: {
          single: (state) => {
            assert.equal(state.operation, 'insert');
            return {
              data: {
                id: '11111111-1111-4111-8111-111111111111',
                invoice_no: state.payload.invoice_no,
                status: 'draft',
              },
              error: null,
            };
          },
        },
      })(table);
    };

    const app = buildApp(inventoryRouter);
    const response = await request(app)
      .post('/api/inventory/receiving/invoices')
      .set('authorization', 'Bearer valid-token')
      .send({
        invoice_no: 'INV-001',
        receive_date: '2026-02-20',
        receive_type: 'purchase',
      });

    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
    assert.equal(response.body.message, 'Audit durability requirement failed');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('inventory stock movement create fails closed when strict audit durability fails', async () => {
  const { inventoryRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'audit_log') {
        return {
          insert: async () => ({ data: null, error: { message: 'audit write failed' } }),
        };
      }
      if (table === 'outbox_events') {
        return {
          insert: async () => ({ data: null, error: { message: 'outbox write failed' } }),
        };
      }

      return createFromStub({
        users: {
          maybeSingle: () => ({ data: baseProfile, error: null }),
        },
        stock_movements: {
          maybeSingle: () => ({ data: { balance_after: 5 }, error: null }),
          single: (state) => {
            if (state.operation !== 'insert') {
              return { data: null, error: null };
            }
            return {
              data: {
                id: '22222222-2222-4222-8222-222222222222',
                balance_after: state.payload.balance_after,
              },
              error: null,
            };
          },
        },
      })(table);
    };

    const app = buildApp(inventoryRouter);
    const response = await request(app)
      .post('/api/inventory/movements')
      .set('authorization', 'Bearer valid-token')
      .send({
        inventory_item_id: '33333333-3333-4333-8333-333333333333',
        movement_type: 'receipt',
        quantity: 2,
      });

    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
    assert.equal(response.body.message, 'Audit durability requirement failed');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('inventory resupply submit fails closed when strict audit durability fails', async () => {
  const { inventoryRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalRpc = (supabaseAdmin as any).rpc;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'audit_log') {
        return {
          insert: async () => ({ data: null, error: { message: 'audit write failed' } }),
        };
      }
      if (table === 'outbox_events') {
        return {
          insert: async () => ({ data: null, error: { message: 'outbox write failed' } }),
        };
      }

      return createFromStub({
        users: {
          maybeSingle: () => ({ data: baseProfile, error: null }),
        },
      })(table);
    };

    (supabaseAdmin as any).rpc = async (fn: string) => {
      assert.equal(fn, 'backend_submit_resupply_request');
      return { data: '44444444-4444-4444-8444-444444444444', error: null };
    };

    const app = buildApp(inventoryRouter);
    const response = await request(app)
      .post('/api/inventory/requests/submit')
      .set('authorization', 'Bearer valid-token')
      .send({
        requestDetails: {
          reporting_period: '2026-W08',
          account_type: 'pharmacy',
          request_type: 'routine',
          request_to: 'central',
        },
        lines: [
          {
            inventory_item_id: '55555555-5555-4555-8555-555555555555',
            quantity_requested: 3,
            amc: 1,
            soh: 2,
            unit_cost: 0,
          },
        ],
      });

    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
    assert.equal(response.body.message, 'Audit durability requirement failed');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).rpc = originalRpc;
  }
});
