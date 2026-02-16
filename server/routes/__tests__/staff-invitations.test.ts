import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const invitationsModule = await import('../staff-invitations');
  const configModule = await import('../../config/supabase');
  return {
    testables: (invitationsModule as any).__testables,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('staff invitation registration schema enforces strong password policy', () => {
  const sourcePath = path.resolve(__dirname, '../staff-invitations.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /password:\s*z/);
  assert.match(source, /\.min\(12,\s*'Password must be at least 12 characters long'\)/);
  assert.match(source, /\.regex\(\/\[a-z\]\//);
  assert.match(source, /\.regex\(\/\[A-Z\]\//);
  assert.match(source, /\.regex\(\/\[0-9\]\//);
  assert.match(source, /\.regex\(\/\[\^A-Za-z0-9\]\//);
});

test('staff invitation helper blocks super_admin role escalation', async () => {
  const { testables } = await loadModules();
  assert.equal(testables.isRoleAssignable('super_admin'), false);
  assert.equal(testables.isRoleAssignable(' Super_Admin '), false);
  assert.equal(testables.isRoleAssignable('doctor'), true);
});

test('staff invitation helper enforces facility isolation for non-super-admin users', async () => {
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

    const allowed = await testables.ensureFacilityAccess('auth-user-1', 'facility-b', 'clinic_admin');
    assert.equal(allowed, false);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('staff invitation helper allows super_admin facility override without membership lookup', async () => {
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

    const allowed = await testables.ensureFacilityAccess('auth-super', 'facility-b', 'super_admin');
    assert.equal(allowed, true);
    assert.equal(fromCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
