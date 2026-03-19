import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('CORS disallowed origins do not throw server errors', () => {
  const serverSource = fs.readFileSync(path.resolve('server/index.ts'), 'utf8');

  assert.doesNotMatch(serverSource, /originCallback\(new Error\('Origin not allowed by CORS'\)\)/);
  assert.doesNotMatch(serverSource, /originCallback\(new Error\('CORS not configured'\)\)/);
  assert.match(serverSource, /originCallback\(null, false\)/);
});
