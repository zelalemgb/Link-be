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
  list?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
};

const createQuery = (handler: TableHandler = {}) => {
  const state: QueryState = {
    operation: 'select',
    filters: {},
  };

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
    gt(column: string, value: unknown) {
      state.filters[column] = { gt: value };
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
      Promise.resolve(handler.list ? handler.list(state) : { data: null, error: null }).then(onFulfilled, onRejected),
  };

  return query;
};

const loadRouteModules = async () => {
  ensureSupabaseEnv();
  const inventoryRouteModule = await import('../inventory');
  const configModule = await import('../../config/supabase');
  return {
    inventoryRouter: inventoryRouteModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

const loadServiceModules = async () => {
  ensureSupabaseEnv();
  const inventoryMutationService = await import('../../services/inventoryMutationService');
  const configModule = await import('../../config/supabase');
  return {
    inventoryMutationService,
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

test('inventory request submit falls back to direct writes when transactional RPC is missing', async () => {
  const { inventoryRouter, supabaseAdmin } = await loadRouteModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalRpc = (supabaseAdmin as any).rpc;

  let insertedRequestPayload: any = null;
  let deletedRequestId: string | null = null;
  let insertedLinesPayload: any[] = [];

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'audit_log' || table === 'outbox_events') {
        return {
          insert: async () => ({ data: { ok: true }, error: null }),
        };
      }

      if (table === 'users') {
        return createQuery({
          maybeSingle: () => ({ data: baseProfile, error: null }),
        });
      }

      if (table === 'inventory_items') {
        return createQuery({
          list: () => ({
            data: [{ id: '11111111-1111-4111-8111-111111111111' }],
            error: null,
          }),
        });
      }

      if (table === 'request_for_resupply') {
        return createQuery({
          single: (state) => {
            assert.equal(state.operation, 'insert');
            insertedRequestPayload = state.payload;
            return {
              data: { id: '22222222-2222-4222-8222-222222222222' },
              error: null,
            };
          },
        });
      }

      if (table === 'request_line_items') {
        return createQuery({
          list: (state) => {
            if (state.operation === 'delete') {
              deletedRequestId = String(state.filters.request_id || '');
            }
            if (state.operation === 'insert') {
              insertedLinesPayload = state.payload;
            }
            return { data: null, error: null };
          },
        });
      }

      return createQuery();
    };

    (supabaseAdmin as any).rpc = async (fn: string) => {
      assert.equal(fn, 'backend_submit_resupply_request');
      return {
        data: null,
        error: {
          message: 'Could not find the function public.backend_submit_resupply_request(p_actor_facility_id, p_actor_tenant_id, p_actor_profile_id, p_request_id, p_request_details, p_lines) in the schema cache',
        },
      };
    };

    const app = buildApp(inventoryRouter);
    const response = await request(app)
      .post('/api/inventory/requests/submit')
      .set('authorization', 'Bearer valid-token')
      .send({
        requestDetails: {
          reporting_period: '2026-W11',
          account_type: 'RDF',
          request_type: 'routine',
          request_to: 'EPSA',
        },
        lines: [
          {
            inventory_item_id: '11111111-1111-4111-8111-111111111111',
            quantity_requested: 12,
            amc: 3,
            soh: 0,
            unit_cost: 2.5,
          },
        ],
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.requestId, '22222222-2222-4222-8222-222222222222');
    assert.equal(insertedRequestPayload.tenant_id, baseProfile.tenant_id);
    assert.equal(insertedRequestPayload.facility_id, baseProfile.facility_id);
    assert.equal(deletedRequestId, '22222222-2222-4222-8222-222222222222');
    assert.equal(insertedLinesPayload.length, 1);
    assert.equal(insertedLinesPayload[0].tenant_id, baseProfile.tenant_id);
    assert.equal(insertedLinesPayload[0].soh, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).rpc = originalRpc;
  }
});

test('inventory mutation dispatchIssueOrder falls back when dispatch RPC is missing', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadServiceModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalRpc = (supabaseAdmin as any).rpc;

  let insertedStockMovement: any = null;
  let issueOrderUpdatePayload: any = null;

  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'audit_log' || table === 'outbox_events') {
        return {
          insert: async () => ({ data: { ok: true }, error: null }),
        };
      }

      if (table === 'physical_inventory_sessions') {
        return createQuery({
          maybeSingle: () => ({ data: null, error: null }),
        });
      }

      if (table === 'issue_orders') {
        return createQuery({
          maybeSingle: () => ({
            data: {
              id: '33333333-3333-4333-8333-333333333333',
              status: 'draft',
              voucher_no: null,
              tenant_id: 'tenant-1',
              facility_id: 'facility-1',
            },
            error: null,
          }),
          list: (state) => {
            if (state.operation === 'update') {
              issueOrderUpdatePayload = state.payload;
            }
            return { data: null, error: null };
          },
        });
      }

      if (table === 'issue_order_items') {
        return createQuery({
          list: () => ({
            data: [
              {
                inventory_item_id: 'inventory-item-1',
                qty_issued: 4,
                batch_no: 'PARA-B1',
              },
            ],
            error: null,
          }),
        });
      }

      if (table === 'inventory_items') {
        return createQuery({
          maybeSingle: () => ({
            data: {
              id: 'inventory-item-1',
              facility_id: 'facility-1',
              tenant_id: 'tenant-1',
              unit_cost: 5,
            },
            error: null,
          }),
        });
      }

      if (table === 'current_stock') {
        return createQuery({
          maybeSingle: () => ({
            data: {
              current_quantity: 10,
            },
            error: null,
          }),
        });
      }

      if (table === 'stock_movements') {
        return createQuery({
          single: (state) => {
            insertedStockMovement = state.payload;
            return {
              data: {
                id: '44444444-4444-4444-8444-444444444444',
                ...state.payload,
              },
              error: null,
            };
          },
        });
      }

      return createQuery();
    };

    (supabaseAdmin as any).rpc = async (fn: string) => {
      assert.equal(fn, 'backend_dispatch_issue_order');
      return {
        data: null,
        error: {
          message: 'Could not find the function public.backend_dispatch_issue_order(p_actor_facility_id, p_actor_tenant_id, p_actor_profile_id, p_order_id) in the schema cache',
        },
      };
    };

    const result = await inventoryMutationService.dispatchIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      orderId: '33333333-3333-4333-8333-333333333333',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.success, true);
      assert.match(String(result.data.voucherNo), /^SIV-/);
    }
    assert.equal(insertedStockMovement.movement_type, 'issue');
    assert.equal(insertedStockMovement.quantity, 4);
    assert.equal(insertedStockMovement.balance_after, 6);
    assert.equal(issueOrderUpdatePayload.status, 'issued');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).rpc = originalRpc;
  }
});
