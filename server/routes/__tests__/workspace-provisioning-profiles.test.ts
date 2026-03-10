import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { __testables } from '../../services/workspaceProvisioning';

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('recommended workspace modules include core and common defaults', () => {
  const modules = __testables.modulesForSetupMode('recommended');

  for (const coreModule of __testables.WORKSPACE_CORE_MODULES) {
    assert.ok(modules.includes(coreModule), `missing core module: ${coreModule}`);
  }

  for (const commonModule of __testables.WORKSPACE_COMMON_MODULES) {
    assert.ok(modules.includes(commonModule), `missing common module: ${commonModule}`);
  }
});

test('full workspace modules include advanced defaults', () => {
  const modules = __testables.modulesForSetupMode('full');

  for (const advancedModule of __testables.WORKSPACE_ADVANCED_MODULES) {
    assert.ok(modules.includes(advancedModule), `missing advanced module: ${advancedModule}`);
  }
});

test('module resolution preserves existing modules while deduplicating', () => {
  const modules = __testables.resolveWorkspaceModules('custom', ['Patients', 'custom_reporting', 'custom_reporting']);

  assert.ok(modules.includes('patients'));
  assert.ok(modules.includes('custom_reporting'));
  const customModuleOccurrences = modules.filter((value) => value === 'custom_reporting').length;
  assert.equal(customModuleOccurrences, 1);
});

test('provider profile defaults to recommended solo provisioning', () => {
  const profile = __testables.resolveWorkspaceProvisioningProfile({ workspaceType: 'provider' });

  assert.equal(profile.workspaceType, 'provider');
  assert.equal(profile.setupMode, 'recommended');
  assert.equal(profile.teamMode, 'solo');
  assert.ok(profile.enabledModules.includes('patients'));
  assert.ok(profile.enabledModules.includes('reception'));
});

test('clinic onboarding route triggers backend workspace provisioning', () => {
  const source = read(path.resolve(__dirname, '../auth.ts'));

  assert.match(source, /import \{ provisionWorkspaceDefaults \} from '\.\.\/services\/workspaceProvisioning';/);
  assert.match(source, /router\.post\('\/clinic-admin-onboarding\/complete'[\s\S]*provisionWorkspaceDefaults/);
  assert.match(source, /user_role:\s*'admin'/);
  assert.match(source, /update\(\{\s*admin_user_id:\s*authUserId\s*\}\)/);
  assert.match(source, /setupMode:\s*'recommended'/);
  assert.match(source, /teamMode:\s*'solo'/);
});
