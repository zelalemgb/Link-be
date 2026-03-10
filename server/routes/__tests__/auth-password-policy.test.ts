import test from 'node:test';
import assert from 'node:assert/strict';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.EMAIL_VERIFICATION_CODE_SECRET =
    process.env.EMAIL_VERIFICATION_CODE_SECRET || 'test-email-verification-secret';
};

const loadAuthTestables = async () => {
  ensureSupabaseEnv();
  const authModule = await import('../auth');
  return (authModule as any).__testables;
};

const basePayload = {
  fullName: 'Test User',
  email: 'test.user@example.com',
  role: 'doctor',
  clinicCode: 'CLN123',
  invitationToken: 'invite-token',
};

test('register-staff schema rejects short passwords', async () => {
  const testables = await loadAuthTestables();
  const result = testables.staffRegistrationSchema.safeParse({
    ...basePayload,
    password: 'Ab1!short',
  });

  assert.equal(result.success, false);
  assert.match(
    String(result.success ? '' : result.error.issues[0]?.message || ''),
    /at least 12 characters/i
  );
});

test('register-staff schema rejects passwords without special characters', async () => {
  const testables = await loadAuthTestables();
  const result = testables.staffRegistrationSchema.safeParse({
    ...basePayload,
    password: 'Abcdefgh1234',
  });

  assert.equal(result.success, false);
  assert.match(
    String(result.success ? '' : result.error.issues[0]?.message || ''),
    /special character/i
  );
});

test('register-staff schema accepts strong password shape', async () => {
  const testables = await loadAuthTestables();
  const result = testables.staffRegistrationSchema.safeParse({
    ...basePayload,
    password: 'Stronger#1234',
  });

  assert.equal(result.success, true);
});
