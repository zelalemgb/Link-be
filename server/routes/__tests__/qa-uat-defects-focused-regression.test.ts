import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const joinFacilityDialogPath = path.resolve(__dirname, '../../../../src/components/JoinFacilityDialog.tsx');
const staffRoutePath = path.resolve(__dirname, '../staff.ts');
const auditLogServicePath = path.resolve(__dirname, '../../services/audit-log.ts');
const staffApprovalMigrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260215143000_transactional_staff_request_approval.sql'
);

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('QA-UAT-001 join dialog missing-user submit shows explicit UX error (no silent return)', () => {
  const source = read(joinFacilityDialogPath);

  assert.ok(
    /if\s*\(!user\)\s*\{[\s\S]*?(setError\(|toast\()/.test(source),
    'Expected explicit user-facing error handling when join submit is attempted without user context'
  );

  assert.doesNotMatch(
    source,
    /if\s*\(!facilityInfo\s*\|\|\s*!selectedRole\s*\|\|\s*!user\)\s*return;/,
    'Missing-user submit must not silently return'
  );
});

test('QA-UAT-002 staff approval path enforces rollback safety when one write fails', () => {
  const source = read(staffRoutePath);
  const approveRouteMatch = source.match(
    /router\.post\('\/admin\/requests\/:id\/approve'[\s\S]*?return res\.json\(\{ success: true \}\);[\s\S]*?\}\);/
  );

  assert.ok(approveRouteMatch, 'Expected staff approve route to exist');

  const approveRouteSource = approveRouteMatch?.[0] || '';
  const hasMultiStepWrites =
    /\.from\('users'\)\s*\.update\(/.test(approveRouteSource) &&
    /\.from\('user_roles'\)\s*\.upsert\(/.test(approveRouteSource) &&
    /\.from\('staff_registration_requests'\)\s*\.update\(/.test(approveRouteSource);

  const hasTransactionalApprovalRpc = /rpc\(\s*'backend_approve_staff_registration_request'/.test(approveRouteSource);
  const hasCompensatingRollback =
    /reviewUpdateError[\s\S]*?from\('user_roles'\)\s*\.(delete|update)\(/.test(approveRouteSource) ||
    /reviewUpdateError[\s\S]*?from\('users'\)\s*\.(delete|update)\(/.test(approveRouteSource) ||
    /catch\s*\([\s\S]*?from\('user_roles'\)\s*\.(delete|update)\(/.test(approveRouteSource) ||
    /catch\s*\([\s\S]*?from\('users'\)\s*\.(delete|update)\(/.test(approveRouteSource);

  if (hasMultiStepWrites) {
    assert.ok(
      hasTransactionalApprovalRpc || hasCompensatingRollback,
      'Expected approval flow to be atomic: use transactional RPC or explicit compensating rollback on partial failure'
    );
  }
});

test('QA-UAT-003 privileged write strict-audit behavior is fail-closed or durably queued', () => {
  const staffRouteSource = read(staffRoutePath);
  const auditSource = read(auditLogServicePath);
  const migrationSource = read(staffApprovalMigrationPath);

  assert.match(staffRouteSource, /rpc\(\s*'backend_approve_staff_registration_request'/);
  assert.match(migrationSource, /INSERT INTO public\.audit_log/);

  const auditCatchMatch = auditSource.match(/catch\s*\(error:\s*any\)\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(auditCatchMatch, 'Expected audit logging catch block to exist');

  const auditCatchSource = auditCatchMatch?.[0] || '';
  const hasFailClosedBehavior = /\bthrow\b|Promise\.reject\(/.test(auditCatchSource);
  const hasDurableQueueBehavior =
    /from\('outbox_events'\)\.insert\(/.test(auditSource) ||
    /from\('audit_log_(queue|failures|dead_letter)'\)\.insert\(/.test(auditSource) ||
    /enqueueAudit/i.test(auditSource) ||
    /audit.*queue/i.test(auditSource);

  assert.ok(
    hasFailClosedBehavior || hasDurableQueueBehavior,
    'Expected strict-audit behavior for privileged writes: fail request on audit failure or persist to durable queue'
  );
});
