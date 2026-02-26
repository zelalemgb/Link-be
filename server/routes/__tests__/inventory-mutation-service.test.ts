import test from 'node:test';
import assert from 'node:assert/strict';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

type QueryState = {
  filters: Record<string, any>;
  payload?: any;
  operation: 'select' | 'insert' | 'update' | 'delete';
};

type TableHandler = {
  maybeSingle?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
  single?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
};

const createFromStub = (handlers: Record<string, TableHandler>) => {
  return (table: string) => {
    const state: QueryState = {
      filters: {},
      operation: 'select',
    };
    const handler = handlers[table] || {};

    const query: any = {
      select() {
        return query;
      },
      eq(column: string, value: any) {
        state.filters[column] = value;
        return query;
      },
      is(column: string, value: any) {
        state.filters[column] = value;
        return query;
      },
      in(column: string, value: any) {
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
    };

    return query;
  };
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const inventoryMutationService = await import('../../services/inventoryMutationService');
  const configModule = await import('../../config/supabase');
  return {
    inventoryMutationService,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('inventory mutation createIssueOrder returns success for authorized actor', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      issue_orders: {
        maybeSingle: () => ({ data: null, error: null }),
        single: (state) => {
          assert.equal(state.operation, 'insert');
          assert.equal(state.payload.period, '2026-W07');
          assert.equal(state.payload.status, 'draft');
          return { data: { id: 'issue-order-1' }, error: null };
        },
      },
    });

    const result = await inventoryMutationService.createIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      payload: {
        period: '2026-W07',
        notes: 'Cycle order',
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.order.id, 'issue-order-1');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation createIssueOrder rejects missing auth context', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let fromCalls = 0;

  try {
    (supabaseAdmin as any).from = () => {
      fromCalls += 1;
      return createFromStub({})('any_table');
    };

    const result = await inventoryMutationService.createIssueOrder({
      actor: {
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      payload: {
        period: '2026-W07',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.code, 'AUTH_MISSING_USER_CONTEXT');
    }
    assert.equal(fromCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation createIssueOrder rejects forbidden role', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let fromCalls = 0;

  try {
    (supabaseAdmin as any).from = () => {
      fromCalls += 1;
      return createFromStub({})('any_table');
    };

    const result = await inventoryMutationService.createIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'doctor',
      },
      payload: {
        period: '2026-W07',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.code, 'PERM_INVENTORY_MUTATION_FORBIDDEN');
    }
    assert.equal(fromCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation updateIssueOrder rejects cross-tenant access', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      issue_orders: {
        maybeSingle: () => ({
          data: {
            id: 'issue-order-1',
            tenant_id: 'tenant-2',
            facility_id: 'facility-2',
            status: 'draft',
            voucher_no: null,
          },
          error: null,
        }),
      },
    });

    const result = await inventoryMutationService.updateIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      orderId: 'issue-order-1',
      payload: {
        period: '2026-W08',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.code, 'TENANT_RESOURCE_SCOPE_VIOLATION');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation createIssueOrder returns conflict for duplicate draft', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      issue_orders: {
        maybeSingle: () => ({ data: { id: 'existing-order' }, error: null }),
      },
    });

    const result = await inventoryMutationService.createIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      payload: {
        period: '2026-W07',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.equal(result.code, 'CONFLICT_DUPLICATE_DRAFT_ISSUE_ORDER');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation createLossAdjustment validates payload reason with stable code', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let fromCalls = 0;

  try {
    (supabaseAdmin as any).from = () => {
      fromCalls += 1;
      return createFromStub({})('any_table');
    };

    const result = await inventoryMutationService.createLossAdjustment({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      payload: {
        inventory_item_id: '7ab0d111-8f9b-4a27-a95a-f9ac8ded5a2a',
        reason: 'bad_reason',
        quantity: 2,
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.code, 'VALIDATION_INVALID_LOSS_REASON');
    }
    assert.equal(fromCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation addIssueOrderItem derives ending balance server-side', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      issue_orders: {
        maybeSingle: () => ({
          data: {
            id: 'issue-order-1',
            tenant_id: 'tenant-1',
            facility_id: 'facility-1',
            status: 'draft',
            voucher_no: null,
          },
          error: null,
        }),
      },
      inventory_items: {
        maybeSingle: () => ({
          data: {
            id: 'inventory-item-1',
            tenant_id: 'tenant-1',
            facility_id: 'facility-1',
          },
          error: null,
        }),
      },
      issue_order_items: {
        maybeSingle: () => ({ data: null, error: null }),
        single: (state) => {
          assert.equal(state.operation, 'insert');
          assert.equal(state.payload.ending_balance, 7);
          return { data: { id: 'issue-item-1' }, error: null };
        },
      },
    });

    const result = await inventoryMutationService.addIssueOrderItem({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      orderId: 'issue-order-1',
      payload: {
        inventory_item_id: 'inventory-item-1',
        beginning_balance: 10,
        qty_received: 5,
        loss: 2,
        adjustment: 0,
        qty_requested: 6,
        qty_issued: 6,
        batch_no: 'B-1',
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.item.id, 'issue-item-1');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation addIssueOrderItem rejects negative ending balance', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      issue_orders: {
        maybeSingle: () => ({
          data: {
            id: 'issue-order-1',
            tenant_id: 'tenant-1',
            facility_id: 'facility-1',
            status: 'draft',
            voucher_no: null,
          },
          error: null,
        }),
      },
      inventory_items: {
        maybeSingle: () => ({
          data: {
            id: 'inventory-item-1',
            tenant_id: 'tenant-1',
            facility_id: 'facility-1',
          },
          error: null,
        }),
      },
    });

    const result = await inventoryMutationService.addIssueOrderItem({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      orderId: 'issue-order-1',
      payload: {
        inventory_item_id: 'inventory-item-1',
        beginning_balance: 0,
        qty_received: 0,
        loss: 2,
        adjustment: 0,
        qty_requested: 0,
        qty_issued: 0,
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.code, 'VALIDATION_NEGATIVE_ENDING_BALANCE');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation createIssueOrder fails closed on strict audit durability failure', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      issue_orders: {
        maybeSingle: () => ({ data: null, error: null }),
        single: () => ({ data: { id: 'issue-order-1' }, error: null }),
      },
      audit_log: {
        single: () => ({ data: null, error: { message: 'audit write failed' } }),
      },
      outbox_events: {
        single: () => ({ data: null, error: { message: 'outbox write failed' } }),
      },
    });

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
        issue_orders: {
          maybeSingle: () => ({ data: null, error: null }),
          single: () => ({ data: { id: 'issue-order-1' }, error: null }),
        },
      })(table);
    };

    const result = await inventoryMutationService.createIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      payload: {
        period: '2026-W07',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation updateIssueOrder fails closed on strict audit durability failure', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
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
        issue_orders: {
          maybeSingle: () => ({
            data: {
              id: 'issue-order-1',
              tenant_id: 'tenant-1',
              facility_id: 'facility-1',
              status: 'draft',
              voucher_no: null,
            },
            error: null,
          }),
          single: (state) => {
            assert.equal(state.operation, 'update');
            return { data: { id: 'issue-order-1' }, error: null };
          },
        },
      })(table);
    };

    const result = await inventoryMutationService.updateIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      orderId: 'issue-order-1',
      payload: {
        period: '2026-W08',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation addIssueOrderItem fails closed on strict audit durability failure', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
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
        issue_orders: {
          maybeSingle: () => ({
            data: {
              id: 'issue-order-1',
              tenant_id: 'tenant-1',
              facility_id: 'facility-1',
              status: 'draft',
              voucher_no: null,
            },
            error: null,
          }),
        },
        inventory_items: {
          maybeSingle: () => ({
            data: {
              id: 'inventory-item-1',
              tenant_id: 'tenant-1',
              facility_id: 'facility-1',
            },
            error: null,
          }),
        },
        issue_order_items: {
          maybeSingle: () => ({ data: null, error: null }),
          single: () => ({ data: { id: 'issue-item-1' }, error: null }),
        },
      })(table);
    };

    const result = await inventoryMutationService.addIssueOrderItem({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      orderId: 'issue-order-1',
      payload: {
        inventory_item_id: 'inventory-item-1',
        beginning_balance: 10,
        qty_received: 3,
        loss: 0,
        adjustment: 0,
        qty_requested: 5,
        qty_issued: 5,
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation deleteIssueOrderItem fails closed on strict audit durability failure', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
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
        issue_order_items: {
          maybeSingle: () => ({
            data: {
              id: 'issue-item-1',
              order_id: 'issue-order-1',
            },
            error: null,
          }),
        },
        issue_orders: {
          maybeSingle: () => ({
            data: {
              id: 'issue-order-1',
              tenant_id: 'tenant-1',
              facility_id: 'facility-1',
              status: 'draft',
              voucher_no: null,
            },
            error: null,
          }),
        },
      })(table);
    };

    const result = await inventoryMutationService.deleteIssueOrderItem({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      itemId: 'issue-item-1',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation createLossAdjustment fails closed on strict audit durability failure', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
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
        inventory_items: {
          maybeSingle: () => ({
            data: {
              id: 'inventory-item-1',
              tenant_id: 'tenant-1',
              facility_id: 'facility-1',
            },
            error: null,
          }),
        },
        loss_adjustments: {
          maybeSingle: () => ({ data: null, error: null }),
          single: () => ({ data: { id: 'adjustment-1' }, error: null }),
        },
      })(table);
    };

    const result = await inventoryMutationService.createLossAdjustment({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      payload: {
        inventory_item_id: 'inventory-item-1',
        reason: 'expired',
        quantity: 2,
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation updateLossAdjustment fails closed on strict audit durability failure', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
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
        inventory_items: {
          maybeSingle: () => ({
            data: {
              id: 'inventory-item-1',
              tenant_id: 'tenant-1',
              facility_id: 'facility-1',
            },
            error: null,
          }),
        },
        loss_adjustments: {
          maybeSingle: () => ({
            data: {
              id: 'adjustment-1',
              tenant_id: 'tenant-1',
              facility_id: 'facility-1',
              status: 'draft',
            },
            error: null,
          }),
          single: (state) => {
            assert.equal(state.operation, 'update');
            return { data: { id: 'adjustment-1' }, error: null };
          },
        },
      })(table);
    };

    const result = await inventoryMutationService.updateLossAdjustment({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      adjustmentId: 'adjustment-1',
      payload: {
        inventory_item_id: 'inventory-item-1',
        reason: 'expired',
        quantity: 2,
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation dispatchIssueOrder is idempotent on transactional replay', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalRpc = (supabaseAdmin as any).rpc;

  try {
    (supabaseAdmin as any).rpc = async (fn: string) => {
      assert.equal(fn, 'backend_dispatch_issue_order');
      return {
        data: {
          success: true,
          already_dispatched: true,
          voucher_no: 'SIV-20260215-ABC12345',
          dispatched_item_count: 0,
        },
        error: null,
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
      orderId: 'de5a0a6a-a14d-4639-a486-b98c6051397c',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.success, true);
      assert.equal(result.data.voucherNo, 'SIV-20260215-ABC12345');
    }
  } finally {
    (supabaseAdmin as any).rpc = originalRpc;
  }
});

test('inventory mutation approveLossAdjustment is idempotent on transactional replay', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalRpc = (supabaseAdmin as any).rpc;

  try {
    (supabaseAdmin as any).rpc = async (fn: string) => {
      assert.equal(fn, 'backend_approve_loss_adjustment');
      return {
        data: {
          success: true,
          already_approved: true,
          reason: 'expired',
          quantity: 4,
        },
        error: null,
      };
    };

    const result = await inventoryMutationService.approveLossAdjustment({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      adjustmentId: '6bd27a33-f1dc-430c-b6f1-3612cbe5f912',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.success, true);
    }
  } finally {
    (supabaseAdmin as any).rpc = originalRpc;
  }
});

test('inventory mutation dispatchIssueOrder maps transactional stock conflict to stable error', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalRpc = (supabaseAdmin as any).rpc;

  try {
    (supabaseAdmin as any).rpc = async () => ({
      data: null,
      error: {
        message: 'Insufficient stock for inventory item 11111111-1111-1111-1111-111111111111',
      },
    });

    const result = await inventoryMutationService.dispatchIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      orderId: 'de5a0a6a-a14d-4639-a486-b98c6051397c',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.equal(result.code, 'CONFLICT_INSUFFICIENT_STOCK');
    }
  } finally {
    (supabaseAdmin as any).rpc = originalRpc;
  }
});

test('inventory mutation dispatchIssueOrder fails closed on strict audit durability failure', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalRpc = (supabaseAdmin as any).rpc;
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).rpc = async () => ({
      data: {
        success: true,
        already_dispatched: false,
        voucher_no: 'SIV-20260215-ABC12345',
        dispatched_item_count: 2,
      },
      error: null,
    });

    (supabaseAdmin as any).from = (table: string) => ({
      insert: async () => {
        if (table === 'audit_log') {
          return { data: null, error: { message: 'audit write failed' } };
        }
        if (table === 'outbox_events') {
          return { data: null, error: { message: 'outbox write failed' } };
        }
        return { data: null, error: null };
      },
    });

    const result = await inventoryMutationService.dispatchIssueOrder({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      orderId: 'de5a0a6a-a14d-4639-a486-b98c6051397c',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).rpc = originalRpc;
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('inventory mutation approveLossAdjustment fails closed on strict audit durability failure', async () => {
  const { inventoryMutationService, supabaseAdmin } = await loadModules();
  const originalRpc = (supabaseAdmin as any).rpc;
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).rpc = async () => ({
      data: {
        success: true,
        already_approved: false,
        reason: 'expired',
        quantity: 4,
      },
      error: null,
    });

    (supabaseAdmin as any).from = (table: string) => ({
      insert: async () => {
        if (table === 'audit_log') {
          return { data: null, error: { message: 'audit write failed' } };
        }
        if (table === 'outbox_events') {
          return { data: null, error: { message: 'outbox write failed' } };
        }
        return { data: null, error: null };
      },
    });

    const result = await inventoryMutationService.approveLossAdjustment({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'pharmacist',
      },
      adjustmentId: '6bd27a33-f1dc-430c-b6f1-3612cbe5f912',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).rpc = originalRpc;
    (supabaseAdmin as any).from = originalFrom;
  }
});
