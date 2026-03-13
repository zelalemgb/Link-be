import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ordersPath = path.resolve(__dirname, '../orders.ts');
const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260313110000_fix_34_order_master_links.sql'
);
const compatViewMigrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260313120000_fix_35_lab_orders_compat_view.sql'
);

const readOrders = () => fs.readFileSync(ordersPath, 'utf8');
const readMigration = () => fs.readFileSync(migrationPath, 'utf8');
const readCompatViewMigration = () => fs.readFileSync(compatViewMigrationPath, 'utf8');

test('orders route accepts and persists master catalog ids for lab and medication orders', () => {
  const source = readOrders();
  assert.match(source, /lab_test_master_id: z\.string\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/);
  assert.match(source, /medication_master_id: z\.string\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/);
  assert.match(source, /lab_test_master_id: order\.lab_test_master_id \|\| null/);
  assert.match(source, /medication_master_id: order\.medication_master_id \|\| null/);
});

test('orders route deduplicates by master id when available and resolves lab sample type through the relation', () => {
  const source = readOrders();
  assert.match(source, /select\('test_name, lab_test_master_id'\)/);
  assert.match(source, /select\('medication_name, dosage, frequency, medication_master_id'\)/);
  assert.match(source, /lab_test_master:lab_test_master_id \(\s*sample_type/s);
  assert.match(source, /const sampleType = labTestMaster\?\.sample_type \|\| null/);
});

test('order master-link migration adds resolver functions, triggers, and lab function rewrites', () => {
  const sql = readMigration();
  assert.match(sql, /ADD COLUMN IF NOT EXISTS lab_test_master_id UUID REFERENCES public\.lab_test_master\(id\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS medication_master_id UUID REFERENCES public\.medication_master\(id\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.resolve_scoped_lab_test_master_id/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.resolve_scoped_medication_master_id/);
  assert.match(sql, /CREATE TRIGGER set_lab_order_master_link/);
  assert.match(sql, /CREATE TRIGGER set_medication_order_master_link/);
  assert.match(sql, /COALESCE\(\s*lo\.lab_test_master_id,\s*public\.resolve_scoped_lab_test_master_id/s);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_lab_orders_with_patient\(\)/);
});

test('compatibility view migration preserves legacy lab-order view columns while using scoped master resolution', () => {
  const sql = readCompatViewMigration();
  assert.match(sql, /CREATE OR REPLACE VIEW public\.v_lab_orders_with_patient AS/);
  assert.match(sql, /lo\.rejection_reason,\s*lo\.rejected_by,\s*lo\.rejected_at,\s*lo\.payment_status/s);
  assert.match(sql, /p\.full_name AS patient_full_name/);
  assert.match(sql, /LEFT JOIN public\.visits v ON v\.id = lo\.visit_id/);
  assert.match(sql, /COALESCE\(\s*lo\.lab_test_master_id,\s*public\.resolve_scoped_lab_test_master_id/s);
  assert.match(sql, /SELECT ltm_inner\.sample_type/);
});
