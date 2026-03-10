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

const createFromStub = (responses: Array<{ data: any; error: any }>) => {
  let index = 0;
  return () => ({
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle: async () => {
      const response = responses[Math.min(index, responses.length - 1)] || { data: null, error: null };
      index += 1;
      return response;
    },
  });
};

test('resolveAssignableRole rejects super_admin without role-table lookup', async () => {
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

    const result = await testables.resolveAssignableRole(' Super_Admin ');
    assert.deepEqual(result, { error: 'Cannot assign super_admin role' });
    assert.equal(fromCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('resolveAssignableRole rejects unknown roles', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub([
      { data: null, error: null }, // by name
      { data: null, error: null }, // by slug
    ]);

    const result = await testables.resolveAssignableRole('nonexistent_role');
    assert.deepEqual(result, { error: 'Requested role is not assignable' });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('resolveAssignableRole accepts valid name role', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub([
      { data: { id: 'role-doctor', name: 'doctor' }, error: null }, // by name
    ]);

    const result = await testables.resolveAssignableRole('Doctor');
    assert.deepEqual(result, { role: { id: 'role-doctor', name: 'doctor' } });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('resolveAssignableRole accepts valid slug mapping and still blocks super_admin payloads', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub([
      { data: null, error: null }, // by name
      { data: { id: 'role-clinic-admin', name: 'clinic_admin' }, error: null }, // by slug
    ]);

    const result = await testables.resolveAssignableRole('clinic-admin');
    assert.deepEqual(result, { role: { id: 'role-clinic-admin', name: 'clinic_admin' } });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('resolveAssignableRole rejects slug lookup that resolves to super_admin', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub([
      { data: null, error: null }, // by name
      { data: { id: 'role-super-admin', name: 'super_admin' }, error: null }, // by slug
    ]);

    const result = await testables.resolveAssignableRole('super-admin');
    assert.deepEqual(result, { error: 'Cannot assign super_admin role' });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('resolveFacilityId denies cross-facility access for non-super-admin users', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub([
      { data: null, error: null }, // membership lookup
    ]);

    const facilityId = await testables.resolveFacilityId({
      user: {
        authUserId: 'auth-user-1',
        facilityId: 'facility-a',
        role: 'admin',
      },
      query: {
        facilityId: 'facility-b',
      },
    });

    assert.equal(facilityId, undefined);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('resolveFacilityId allows super_admin cross-facility access without membership lookup', async () => {
  const { testables, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let fromCalls = 0;

  try {
    (supabaseAdmin as any).from = () => {
      fromCalls += 1;
      return createFromStub([{ data: null, error: null }])();
    };

    const facilityId = await testables.resolveFacilityId({
      user: {
        authUserId: 'auth-user-super',
        facilityId: 'facility-a',
        role: 'super_admin',
      },
      query: {
        facilityId: 'facility-b',
      },
    });

    assert.equal(facilityId, 'facility-b');
    assert.equal(fromCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
