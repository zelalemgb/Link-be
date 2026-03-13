import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

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

test('inventory routes use transactional stock and receiving RPCs and expose new control/report endpoints', () => {
  const inventoryPath = path.resolve(__dirname, '../inventory.ts');
  const controllerPath = path.resolve(__dirname, '../../controllers/inventory.ts');
  const source = fs.readFileSync(inventoryPath, 'utf8');
  const controllerSource = fs.readFileSync(controllerPath, 'utf8');

  assert.match(controllerSource, /backend_create_stock_movement/);
  assert.match(source, /backend_finalize_receiving_invoice/);
  assert.match(source, /router\.get\('\/physical-inventory\/sessions'/);
  assert.match(source, /router\.post\('\/physical-inventory\/sessions'/);
  assert.match(source, /router\.post\('\/physical-inventory\/sessions\/:sessionId\/commit'/);
  assert.match(source, /router\.post\('\/physical-inventory\/sessions\/:sessionId\/end'/);
  assert.match(source, /router\.get\('\/reports\/stock-status'/);
  assert.match(source, /router\.get\('\/reports\/bin-card'/);
  assert.match(source, /router\.get\('\/reports\/expiry'/);
  assert.match(source, /router\.get\('\/reports\/financial\/cost'/);
  assert.match(source, /router\.get\('\/reports\/financial\/wastage'/);
  assert.match(source, /router\.get\('\/reports\/financial\/activity'/);
  assert.match(source, /router\.get\('\/reports\/financial\/consumption'/);
});

test('inventory receiving finalize rejects zero-quantity items before stock posting', async () => {
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
      return createFromStub({
        users: {
          maybeSingle: () => ({ data: baseProfile, error: null }),
        },
      })(table);
    };

    const app = buildApp(inventoryRouter);
    const response = await request(app)
      .post('/api/inventory/receiving/invoices/11111111-1111-4111-8111-111111111111/finalize')
      .set('authorization', 'Bearer valid-token')
      .send({
        items: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            inventory_item_id: '33333333-3333-4333-8333-333333333333',
            quantity: 0,
            batch_no: 'B-1',
            unit_cost: 10,
          },
        ],
      });

    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /greater than 0/i);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('inventory physical count create fails when another session is already locking stock', async () => {
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

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({ data: baseProfile, error: null }),
      },
      physical_inventory_sessions: {
        maybeSingle: () => ({
          data: {
            id: '44444444-4444-4444-8444-444444444444',
            inventory_id: 'PHY-20260313-LOCKED',
            status: 'draft',
          },
          error: null,
        }),
      },
    });

    const app = buildApp(inventoryRouter);
    const response = await request(app)
      .post('/api/inventory/physical-inventory/sessions')
      .set('authorization', 'Bearer valid-token')
      .send({
        account_type: 'RDF',
        period_type: 'monthly',
      });

    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'CONFLICT_INVENTORY_COUNT_LOCKED');
    assert.match(String(response.body.message), /PHY-20260313-LOCKED/);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});
