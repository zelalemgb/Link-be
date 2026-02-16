import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260214113000_harden_super_admin_functions.sql'
);

const readMigration = () => fs.readFileSync(migrationPath, 'utf8');

test('hardening migration enforces super-admin caller check for promote_to_super_admin', () => {
  const sql = readMigration();
  assert.match(sql, /IF v_actor_profile\.id IS NULL OR v_actor_profile\.user_role <> 'super_admin'/);
  assert.match(sql, /RAISE EXCEPTION 'Not authorized';/);
});

test('hardening migration revokes promote_to_super_admin execution from authenticated users', () => {
  const sql = readMigration();
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.promote_to_super_admin\(text\) FROM authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.promote_to_super_admin\(text\) TO service_role;/);
});

test('hardening migration blocks super_admin role assignment in admin_update_roles', () => {
  const sql = readMigration();
  assert.match(sql, /IF array_position\(p_roles, 'super_admin'\) IS NOT NULL THEN/);
  assert.match(sql, /RAISE EXCEPTION 'Cannot assign super_admin role';/);
  assert.match(sql, /v_target_role public\.user_role;/);
});

