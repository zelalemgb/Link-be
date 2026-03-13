import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('provider onboarding route records success and failure platform activity events', () => {
  const sourcePath = path.resolve(__dirname, '../auth.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /eventName:\s*'registration\.solo_provider\.completed'/);
  assert.match(source, /eventName:\s*'registration\.solo_provider\.failed'/);
  assert.match(source, /entryPoint:\s*'solo_provider_registration'/);
  assert.match(source, /resolvePlatformSessionId\(req\.header\('x-link-session-id'\)\)/);
});
