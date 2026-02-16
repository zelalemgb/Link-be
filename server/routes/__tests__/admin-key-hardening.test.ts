import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve(__dirname, '../../index.ts');
const monitoringRoutePath = path.resolve(__dirname, '../monitoring.ts');

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('super-admin bootstrap route uses role-claim authorization instead of static API key', () => {
  const source = read(indexPath);
  assert.match(source, /app\.post\('\/api\/admin\/super-admin', requireUser, superAdminGuard,/);
  assert.doesNotMatch(source, /app\.post\('\/api\/admin\/super-admin', adminKeyGuard,/);
});

test('monitoring metrics route uses role-claim authorization instead of static API key', () => {
  const source = read(monitoringRoutePath);
  assert.match(source, /router\.get\('\/metrics', requireUser, superAdminGuard,/);
  assert.doesNotMatch(source, /router\.get\('\/metrics', adminKeyGuard,/);
});
