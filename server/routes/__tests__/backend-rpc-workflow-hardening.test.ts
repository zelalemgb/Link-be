import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const inventoryPath = path.resolve(__dirname, '../inventory.ts');
const staffPath = path.resolve(__dirname, '../staff.ts');
const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('inventory workflow routes call transactional backend RPCs', () => {
  const source = read(inventoryPath);
  assert.match(source, /rpc\(\s*'backend_submit_resupply_request'/);
  assert.match(source, /rpc\(\s*'backend_create_receiving_from_request'/);
});

test('staff role update route uses transactional backend RPC', () => {
  const source = read(staffPath);
  assert.match(source, /rpc\(\s*'backend_update_staff_roles'/);
  assert.match(source, /rpc\(\s*'backend_approve_staff_registration_request'/);
});
