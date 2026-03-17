import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../admin-data.ts'),
  'utf8',
);

test('admin data generic routes delegate departments and wards to dedicated handlers', () => {
  assert.match(source, /const delegatedTableRoutes = new Set\(\['departments', 'wards'\]\)/);
  assert.match(source, /router\.get\('\/:table', async \(req, res, next\) => \{[\s\S]*delegatedTableRoutes\.has\(tableKey\)[\s\S]*return next\(\);/);
  assert.match(source, /router\.post\('\/:table', async \(req, res, next\) => \{[\s\S]*delegatedTableRoutes\.has\(tableKey\)[\s\S]*return next\(\);/);
  assert.match(source, /router\.put\('\/:table\/:id', async \(req, res, next\) => \{[\s\S]*delegatedTableRoutes\.has\(tableKey\)[\s\S]*return next\(\);/);
  assert.match(source, /router\.delete\('\/:table\/:id', async \(req, res, next\) => \{[\s\S]*delegatedTableRoutes\.has\(tableKey\)[\s\S]*return next\(\);/);
  assert.match(source, /router\.post\('\/:table\/bulk', async \(req, res, next\) => \{[\s\S]*delegatedTableRoutes\.has\(tableKey\)[\s\S]*return next\(\);/);
});
