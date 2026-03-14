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

test('super admin review route is wired for clinic and staff approvals', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'server/index.ts'), 'utf8');

  assert.match(source, /app\.post\('\/api\/super-admin\/approvals\/:id\/review'/);
  assert.match(source, /review-clinic-registration/);
  assert.match(source, /backend_approve_staff_registration_request/);
});
