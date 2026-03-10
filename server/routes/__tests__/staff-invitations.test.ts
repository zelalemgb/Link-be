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

test('staff invitation route exposes bounded team-mode update schema', () => {
  const sourcePath = path.resolve(__dirname, '../staff-invitations.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /const teamModeUpdateSchema = z\.object\(\{/);
  assert.match(source, /teamMode:\s*z\.enum\(\['solo', 'small_team', 'full_team'\]\)/);
  assert.doesNotMatch(source, /teamMode:\s*z\.enum\(\['legacy'/);
});

test('staff invitation route supports reading and updating team mode', () => {
  const sourcePath = path.resolve(__dirname, '../staff-invitations.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /router\.get\('\/team-mode', requireUser, requireScopedUser/);
  assert.match(source, /router\.put\('\/team-mode', requireUser, requireScopedUser/);
  assert.match(source, /const tenantUpdatePayload: Record<string, string> = \{/);
  assert.match(source, /team_mode:\s*parsed\.data\.teamMode/);
});

test('team mode upgrade promotes provider workspaces to clinic metadata', () => {
  const sourcePath = path.resolve(__dirname, '../staff-invitations.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(
    source,
    /currentTenantRow\.workspace_type === 'provider' && parsed\.data\.teamMode !== 'solo'/
  );
  assert.match(source, /tenantUpdatePayload\.workspace_type = 'clinic';/);
  assert.match(source, /tenantUpdatePayload\.setup_mode = 'recommended';/);
});

test('staff invitation manager rules include doctor facility-owner path', () => {
  const sourcePath = path.resolve(__dirname, '../staff-invitations.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /const isFacilityOwnerManager = async/);
  assert.match(source, /normalizeRole\(role \|\| ''\) !== 'doctor'/);
  assert.match(source, /return data\.admin_user_id === authUserId;/);
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

test('doctor facility owner can manage invitations without clinic_admin primary role', async () => {
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
      maybeSingle: async () => ({
        data: { id: 'facility-1', admin_user_id: 'doctor-owner-1', tenant_id: 'tenant-1' },
        error: null,
      }),
    });

    const allowed = await testables.canManageInvitationsForFacility({
      role: 'doctor',
      authUserId: 'doctor-owner-1',
      facilityId: 'facility-1',
      tenantId: 'tenant-1',
    });
    assert.equal(allowed, true);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
