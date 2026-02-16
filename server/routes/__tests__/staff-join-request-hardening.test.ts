import test from 'node:test';
import assert from 'node:assert/strict';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const staffModule = await import('../staff');
  const configModule = await import('../../config/supabase');
  return {
    testables: (staffModule as any).__testables,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

type QueryResult = { data: any; error: any };

const createFromStub = (handlers: Record<string, (filters: Record<string, any>) => QueryResult>) => {
  return (table: string) => {
    const filters: Record<string, any> = {};
    return {
      select() {
        return this;
      },
      eq(column: string, value: any) {
        filters[column] = value;
        return this;
      },
      maybeSingle: async () => {
        const handler = handlers[table];
        return handler ? handler(filters) : { data: null, error: null };
      },
    };
  };
};

test('join-request eligibility denies cross-tenant facility checks for non-super-admin users', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      facilities: () => ({
        data: {
          id: 'facility-2',
          name: 'Remote Facility',
          tenant_id: 'tenant-2',
          verification_status: 'approved',
          verified: true,
        },
        error: null,
      }),
    });

    const result = await testables.resolveJoinRequestEligibility({
      authUserId: 'auth-user-1',
      tenantId: 'tenant-1',
      role: 'doctor',
      clinicCode: 'LINK02',
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'TENANT_FACILITY_SCOPE_VIOLATION');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('join-request eligibility rejects existing membership in target facility', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      facilities: () => ({
        data: {
          id: 'facility-1',
          name: 'Primary Facility',
          tenant_id: 'tenant-1',
          verification_status: 'approved',
          verified: true,
        },
        error: null,
      }),
      users: () => ({ data: { id: 'user-membership' }, error: null }),
    });

    const result = await testables.resolveJoinRequestEligibility({
      authUserId: 'auth-user-1',
      tenantId: 'tenant-1',
      role: 'doctor',
      clinicCode: 'LINK01',
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.code, 'CONFLICT_EXISTING_MEMBERSHIP');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('join-request eligibility rejects duplicate pending requests', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      facilities: () => ({
        data: {
          id: 'facility-1',
          name: 'Primary Facility',
          tenant_id: 'tenant-1',
          verification_status: 'approved',
          verified: true,
        },
        error: null,
      }),
      users: () => ({ data: null, error: null }),
      staff_registration_requests: () => ({ data: { id: 'req-1' }, error: null }),
    });

    const result = await testables.resolveJoinRequestEligibility({
      authUserId: 'auth-user-1',
      tenantId: 'tenant-1',
      role: 'doctor',
      clinicCode: 'LINK01',
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(result.code, 'CONFLICT_PENDING_JOIN_REQUEST');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('join-request eligibility returns canRequest=false when facility is not accepting staff', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      facilities: () => ({
        data: {
          id: 'facility-1',
          name: 'Primary Facility',
          tenant_id: 'tenant-1',
          verification_status: 'rejected',
          verified: false,
        },
        error: null,
      }),
      users: () => ({ data: null, error: null }),
      staff_registration_requests: () => ({ data: null, error: null }),
    });

    const result = await testables.resolveJoinRequestEligibility({
      authUserId: 'auth-user-1',
      tenantId: 'tenant-1',
      role: 'doctor',
      clinicCode: 'LINK01',
    });

    assert.equal(result.ok, true);
    assert.equal(result.canRequest, false);
    assert.equal(result.facility.id, 'facility-1');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
