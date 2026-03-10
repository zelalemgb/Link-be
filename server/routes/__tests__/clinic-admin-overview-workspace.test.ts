import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('clinic admin overview loads workspace metadata from tenant', () => {
  const source = read(path.resolve(__dirname, '../../index.ts'));

  assert.match(
    source,
    /\.from\('tenants'\)\s*\.select\('workspace_type, setup_mode, team_mode, enabled_modules'\)/
  );
  assert.match(source, /let workspace = normalizeWorkspaceMetadata\(null\);/);
  assert.match(source, /workspace = normalizeWorkspaceMetadata\(workspaceRow as any\);/);
});

test('clinic admin overview response includes workspace metadata payload', () => {
  const source = read(path.resolve(__dirname, '../../index.ts'));

  assert.match(source, /return res\.json\(\{[\s\S]*workspace,[\s\S]*staffCount:/);
});

test('clinic admin overview allows facility-owner doctors as upgrade bridge', () => {
  const source = read(path.resolve(__dirname, '../../index.ts'));

  assert.match(source, /const isFacilityOwnerDoctor =/);
  assert.match(source, /role === 'doctor'/);
  assert.match(source, /facility\.admin_user_id === authUserId/);
  assert.match(source, /if \(!clinicAdminOverviewRoles\.has\(role\) && !isFacilityOwnerDoctor\)/);
});
