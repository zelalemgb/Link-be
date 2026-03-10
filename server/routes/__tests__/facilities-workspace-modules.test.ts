import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'server/routes/facilities.ts'),
  'utf8'
);

test('facilities route exposes workspace modules management endpoint', () => {
  assert.match(source, /router\.patch\('\/:id\/workspace\/modules'/);
  assert.match(source, /workspaceModulesUpdateSchema/);
  assert.match(source, /enabledModules:\s*z\.array/);
});

test('workspace modules endpoint updates tenant setup mode and enabled modules', () => {
  assert.match(source, /\.from\('tenants'\)\s*\.update\(\{[\s\S]*setup_mode:\s*setupMode,[\s\S]*enabled_modules:\s*enabledModules,/);
  assert.match(source, /normalizeWorkspaceMetadata\(updatedTenant as any\)/);
});
