import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const masterDataPath = path.resolve(__dirname, '../master-data.ts');
const read = () => fs.readFileSync(masterDataPath, 'utf8');

test('master-data routes require tenant scope helper for scoped operations', () => {
  const source = read();
  assert.match(source, /const requireMasterDataScope =/);
  assert.match(source, /const facilityScopeFilter =/);
  assert.match(source, /Missing tenant context/);
});

test('master-data writes enforce admin guard for medication and imaging endpoints', () => {
  const source = read();
  assert.match(source, /router\.post\('\/medications'[\s\S]*?ensureMasterDataAdmin/);
  assert.match(source, /router\.put\('\/medications\/:id'[\s\S]*?ensureMasterDataAdmin/);
  assert.match(source, /router\.delete\('\/medications\/:id'[\s\S]*?ensureMasterDataAdmin/);
  assert.match(source, /router\.post\('\/imaging'[\s\S]*?ensureMasterDataAdmin/);
  assert.match(source, /router\.put\('\/imaging\/:id'[\s\S]*?ensureMasterDataAdmin/);
  assert.match(source, /router\.delete\('\/imaging\/:id'[\s\S]*?ensureMasterDataAdmin/);
});

test('master-data updates and deletes include tenant scoping predicates', () => {
  const source = read();
  assert.match(source, /from\('medical_services'\)[\s\S]*?\.eq\('tenant_id', tenantId\)[\s\S]*?\.eq\('id', req\.params\.id\)/);
  assert.match(source, /from\('programs'\)[\s\S]*?\.eq\('tenant_id', tenantId\)[\s\S]*?\.eq\('id', req\.params\.id\)/);
  assert.match(source, /from\('medication_master'\)[\s\S]*?\.eq\('tenant_id', tenantId\)[\s\S]*?\.eq\('id', req\.params\.id\)/);
  assert.match(source, /from\('imaging_study_catalog'\)[\s\S]*?\.eq\('tenant_id', tenantId\)[\s\S]*?\.eq\('id', req\.params\.id\)/);
});
