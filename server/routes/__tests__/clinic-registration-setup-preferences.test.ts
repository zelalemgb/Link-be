import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('public clinic registration endpoint accepts setup preferences payload', () => {
  const source = read(path.resolve(__dirname, '../../index.ts'));

  assert.match(source, /workspace:\s*z\s*\./);
  assert.match(source, /setupMode:\s*z\.enum\(\['recommended', 'custom', 'full'\]\)/);
  assert.match(source, /enabledModules:\s*z\.array\(z\.string\(\)\.trim\(\)\.min\(1\)\.max\(64\)\)\.optional\(\)/);
});

test('public clinic registration endpoint persists setup preferences when available', () => {
  const source = read(path.resolve(__dirname, '../../index.ts'));

  assert.match(source, /requested_setup_mode:\s*requestedSetupMode/);
  assert.match(source, /requested_modules:\s*requestedModules/);
  assert.match(source, /isWorkspacePreferenceColumnError/);
  assert.match(source, /if \(error && isWorkspacePreferenceColumnError\(error\.message\)\)/);
});

test('approval flow carries registration setup preferences into tenant metadata', () => {
  const source = read(
    path.resolve(
      __dirname,
      '../../../supabase/functions/review-clinic-registration/index.ts'
    )
  );

  assert.match(source, /const requestedSetupMode = normalizeRequestedSetupMode\(registration\.requested_setup_mode\);/);
  assert.match(source, /setup_mode:\s*requestedSetupMode/);
  assert.match(source, /enabled_modules:\s*requestedModules/);
  assert.match(source, /resolveRequestedModules/);
});
