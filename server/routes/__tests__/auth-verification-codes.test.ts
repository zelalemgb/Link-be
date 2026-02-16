import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadAuthTestables = async () => {
  ensureSupabaseEnv();
  const authModule = await import('../auth');
  return (authModule as any).__testables;
};

test('verification code hash is deterministic and email-normalized', async () => {
  const testables = await loadAuthTestables();
  const normalized = testables.hashVerificationCode('nurse@example.com', '123456');
  const mixedCase = testables.hashVerificationCode(' Nurse@Example.com ', '123456');

  assert.equal(normalized, mixedCase);
  assert.notEqual(normalized, '123456');
  assert.match(normalized, /^[a-f0-9]{64}$/);
});

test('auth route verifies codes via dedicated endpoint and no longer compares plaintext directly', () => {
  const sourcePath = path.resolve(__dirname, '../auth.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /router\.post\('\/verify-registration-code'/);
  assert.match(source, /const\s+hashedCode\s*=\s*hashVerificationCode/);
  assert.match(source, /code:\s*hashedCode/);
  assert.doesNotMatch(source, /\.eq\('code',\s*verificationCode\)/);
});
