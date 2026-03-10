import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const patientPortalPath = path.resolve(__dirname, '../patient-portal.ts');
const inventoryPath = path.resolve(__dirname, '../inventory.ts');
const inventoryControllerPath = path.resolve(__dirname, '../../controllers/inventory.ts');
const inventoryMutationServicePath = path.resolve(__dirname, '../../services/inventoryMutationService.ts');
const receivingManagementPath = path.resolve(__dirname, '../../../../src/components/inventory/ReceivingManagement.tsx');

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('patient portal facilities route enforces tenant scoping', () => {
  const source = read(patientPortalPath);
  assert.match(source, /if \(!tenantId\)\s*\{\s*return res\.status\(400\)\.json\(\{ error: 'Missing tenant context' \}\);/);
  assert.match(source, /\.eq\('tenant_id', tenantId\)/);
  assert.match(source, /\.eq\('verified', true\)/);
});

test('inventory routes expose backend write endpoints with scoped guards', () => {
  const source = read(inventoryPath);
  assert.match(source, /router\.post\('\/requests\/submit'/);
  assert.match(source, /router\.post\('\/receiving\/from-request'/);
  assert.match(source, /router\.post\('\/receiving\/invoices'/);
  assert.match(source, /router\.put\('\/receiving\/invoices\/:invoiceId'/);
  assert.match(source, /router\.post\('\/receiving\/invoices\/:invoiceId\/items'/);
  assert.match(source, /router\.patch\('\/receiving\/items\/:itemId'/);
  assert.match(source, /router\.delete\('\/receiving\/items\/:itemId'/);
  assert.match(source, /router\.post\('\/receiving\/invoices\/:invoiceId\/finalize'/);
  assert.match(source, /router\.post\('\/issue-orders'/);
  assert.match(source, /router\.put\('\/issue-orders\/:orderId'/);
  assert.match(source, /router\.post\('\/issue-orders\/:orderId\/items'/);
  assert.match(source, /router\.delete\('\/issue-orders\/items\/:itemId'/);
  assert.match(source, /router\.post\('\/issue-orders\/:orderId\/dispatch'/);
  assert.match(source, /router\.post\('\/loss-adjustments'/);
  assert.match(source, /router\.put\('\/loss-adjustments\/:adjustmentId'/);
  assert.match(source, /router\.post\('\/loss-adjustments\/:adjustmentId\/approve'/);
  assert.match(source, /sendContractError\(res, result\.status, result\.code, result\.message\)/);
  assert.match(source, /resolveInventoryMutationActor/);
  assert.match(source, /const uuidParamSchema = z\.string\(\)\.uuid\(\)/);
  assert.match(source, /resolveRequiredUuidParam/);
  assert.match(source, /VALIDATION_INVALID_ISSUE_ORDER_ID/);
  assert.match(source, /VALIDATION_INVALID_ISSUE_ORDER_ITEM_ID/);
  assert.match(source, /VALIDATION_INVALID_LOSS_ADJUSTMENT_ID/);
  assert.match(source, /Missing facility or tenant context/);
  assert.match(source, /backend_submit_resupply_request/);
  assert.match(source, /backend_create_receiving_from_request/);
  assert.match(source, /outside your facility/);
});

test('receiving management frontend writes are routed through backend inventory API', () => {
  const source = read(receivingManagementPath);
  assert.match(source, /inventoryApi\.createReceivingInvoice\(/);
  assert.match(source, /inventoryApi\.updateReceivingInvoice\(/);
  assert.match(source, /inventoryApi\.addReceivingInvoiceItem\(/);
  assert.match(source, /inventoryApi\.updateReceivingInvoiceItem\(/);
  assert.match(source, /inventoryApi\.deleteReceivingInvoiceItem\(/);
  assert.match(source, /inventoryApi\.finalizeReceivingInvoice\(/);
  assert.doesNotMatch(source, /\.from\('receiving_invoices'\)\s*\.insert/);
  assert.doesNotMatch(source, /\.from\('receiving_invoices'\)\s*\.update/);
  assert.doesNotMatch(source, /\.from\('receiving_invoice_items'\)\s*\.insert/);
  assert.doesNotMatch(source, /\.from\('receiving_invoice_items'\)\s*\.update/);
  assert.doesNotMatch(source, /\.from\('receiving_invoice_items'\)\s*\.upsert/);
  assert.doesNotMatch(source, /\.from\('receiving_invoice_items'\)\s*\.delete/);
  assert.doesNotMatch(source, /\.from\('request_for_resupply'\)\s*\.update/);
});

test('inventory draft and receiving/stock writes enforce strict audit durability', () => {
  const routeSource = read(inventoryPath);
  const controllerSource = read(inventoryControllerPath);
  const serviceSource = read(inventoryMutationServicePath);

  assert.match(routeSource, /const recordInventoryStrictAudit[\s\S]*strict:\s*true/);
  assert.match(routeSource, /action:\s*'submit_resupply_request'/);
  assert.match(routeSource, /action:\s*'create_receiving_from_resupply_request'/);
  assert.match(routeSource, /action:\s*'create_receiving_invoice'/);
  assert.match(routeSource, /action:\s*'update_receiving_invoice'/);
  assert.match(routeSource, /action:\s*'create_receiving_invoice_item'/);
  assert.match(routeSource, /action:\s*'update_receiving_invoice_item'/);
  assert.match(routeSource, /action:\s*'delete_receiving_invoice_item'/);
  assert.match(routeSource, /action:\s*'finalize_receiving_invoice'/);
  assert.match(routeSource, /CONFLICT_AUDIT_DURABILITY_FAILURE/);

  assert.match(controllerSource, /action:\s*'create_inventory_item'/);
  assert.match(controllerSource, /action:\s*'create_stock_movement'/);
  assert.match(controllerSource, /CONFLICT_AUDIT_DURABILITY_FAILURE/);
  assert.match(controllerSource, /strict:\s*true/);

  assert.match(serviceSource, /action:\s*'create_issue_order'[\s\S]*strict:\s*true/);
  assert.match(serviceSource, /action:\s*'update_issue_order'[\s\S]*strict:\s*true/);
  assert.match(serviceSource, /action:\s*'add_issue_order_item'[\s\S]*strict:\s*true/);
  assert.match(serviceSource, /action:\s*'delete_issue_order_item'[\s\S]*strict:\s*true/);
  assert.match(serviceSource, /action:\s*'create_loss_adjustment'[\s\S]*strict:\s*true/);
  assert.match(serviceSource, /action:\s*'update_loss_adjustment'[\s\S]*strict:\s*true/);
});
