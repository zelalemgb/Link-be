import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('super admin dashboard includes pending clinic registrations in approvals', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/index.ts'), 'utf8');

  assert.match(source, /\.from\('clinic_registrations'\)/);
  assert.match(source, /request_type:\s*'clinic_registration'/);
  assert.match(source, /clinic_name:\s*registration\.clinic_name/);
});
