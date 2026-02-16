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

test('staff admin helper blocks super_admin role escalation before role table lookup', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let fromCalls = 0;

  try {
    (supabaseAdmin as any).from = () => {
      fromCalls += 1;
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: null, error: null }),
      };
    };

    const result = await testables.resolveAssignableRole(' super_admin ');
    assert.deepEqual(result, { error: 'Cannot assign super_admin role' });
    assert.equal(fromCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('staff admin helper denies cross-facility role management for non-super-admin users', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle: async () => ({ data: null, error: null }),
    });

    const resolvedFacilityId = await testables.resolveFacilityId({
      user: {
        authUserId: 'auth-user-1',
        facilityId: 'facility-a',
        role: 'clinic_admin',
      },
      query: {
        facilityId: 'facility-b',
      },
    });
    assert.equal(resolvedFacilityId, undefined);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
