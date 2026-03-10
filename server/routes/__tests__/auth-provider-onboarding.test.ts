import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('provider onboarding route defines validation schema and protected endpoint', () => {
  const source = read(path.resolve(__dirname, '../auth.ts'));

  assert.match(source, /const completeProviderOnboardingSchema = z\.object\(\{/);
  assert.match(source, /router\.post\('\/provider-onboarding\/complete', requireUser, async \(req, res\) => \{/);
  assert.match(source, /const parsed = completeProviderOnboardingSchema\.safeParse\(req\.body \|\| \{\}\);/);
});

test('provider onboarding provisions provider workspace defaults', () => {
  const source = read(path.resolve(__dirname, '../auth.ts'));

  assert.match(source, /workspaceType:\s*'provider'/);
  assert.match(source, /setupMode:\s*'recommended'/);
  assert.match(source, /teamMode:\s*'solo'/);
  assert.match(source, /provisionWorkspaceDefaults\(\{/);
});

test('provider onboarding persists provider workspace metadata on tenant creation', () => {
  const source = read(path.resolve(__dirname, '../auth.ts'));

  assert.match(source, /workspace_type:\s*'provider'/);
  assert.match(source, /team_mode:\s*'solo'/);
  assert.match(source, /setup_mode:\s*'recommended'/);
});
