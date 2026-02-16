import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const staffRoutePath = path.resolve(__dirname, '../staff.ts');
const authRoutePath = path.resolve(__dirname, '../auth.ts');
const patientPortalRoutePath = path.resolve(__dirname, '../patient-portal.ts');
const inventoryRoutePath = path.resolve(__dirname, '../inventory.ts');
const staffApprovalPanelPath = path.resolve(__dirname, '../../../../src/components/admin/StaffApprovalPanel.tsx');
const joinFacilityDialogPath = path.resolve(__dirname, '../../../../src/components/JoinFacilityDialog.tsx');
const staffApiPath = path.resolve(__dirname, '../../../../src/services/api/staffApi.ts');
const issueOrdersPath = path.resolve(__dirname, '../../../../src/components/inventory/IssueOrders.tsx');
const lossAdjustmentsPath = path.resolve(__dirname, '../../../../src/components/inventory/LossAdjustments.tsx');
const doctorDashboardPath = path.resolve(__dirname, '../../../../src/components/DoctorDashboard.tsx');
const inventoryMutationServicePath = path.resolve(__dirname, '../../services/inventoryMutationService.ts');
const patientVisitStatusServicePath = path.resolve(__dirname, '../../services/patientVisitStatusService.ts');
const inventoryTransactionalMigrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260215113000_transactional_inventory_dispatch_and_loss_approval.sql'
);
const staffApprovalTransactionalMigrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260215143000_transactional_staff_request_approval.sql'
);

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

test('QA-W1-ROLE-001 role escalation guard blocks super_admin assignment in staff route', () => {
  const source = read(staffRoutePath);
  assert.match(source, /const nonAssignableRoles = new Set\(\['super_admin'\]\)/);
  assert.match(source, /if \(nonAssignableRoles\.has\(normalizedRole\)\)\s*\{\s*return \{ error: 'Cannot assign super_admin role' as const \};/);
  assert.match(source, /if \(roles\.some\(\(role\) => normalizeRole\(role\) === 'super_admin'\)\)\s*\{\s*return res\.status\(400\)\.json\(\{ error: 'Cannot assign super_admin role' \}\);/);
});

test('QA-W1-TENANT-001 staff approval endpoints enforce facility isolation', () => {
  const source = read(staffRoutePath);
  assert.match(source, /router\.post\('\/admin\/requests\/:id\/approve'/);
  assert.match(source, /router\.post\('\/admin\/requests\/:id\/reject'/);
  assert.match(source, /if \(!facilityId \|\| request\.facility_id !== facilityId\)\s*\{\s*return sendContractError\(\s*res,\s*403,\s*'TENANT_RESOURCE_SCOPE_VIOLATION',\s*'Cannot manage requests outside your facility'\s*\);/);
});

test('QA-W1-TENANT-002 patient portal write routes enforce tenant context and tenant scoping', () => {
  const source = read(patientPortalRoutePath);
  assert.match(source, /return res\.status\(400\)\.json\(\{ error: 'Missing tenant context' \}\);/);
  assert.match(source, /\.eq\('tenant_id', tenantId\)/);
});

test('QA-W1-STAFF-001 staff approval UI uses backend staffApi and avoids direct table writes', () => {
  const source = read(staffApprovalPanelPath);
  assert.match(source, /staffApi\.listPendingRequests\(/);
  assert.match(source, /staffApi\.approveRequest\(/);
  assert.match(source, /staffApi\.rejectRequest\(/);
  assert.doesNotMatch(source, /\.from\('staff_registration_requests'\)/);
});

test('QA-W1-STAFF-002 backend staff admin request routes exist for list/approve/reject', () => {
  const source = read(staffRoutePath);
  assert.match(source, /router\.get\('\/admin\/requests'/);
  assert.match(source, /router\.post\('\/admin\/requests\/:id\/approve'/);
  assert.match(source, /router\.post\('\/admin\/requests\/:id\/reject'/);
});

test('QA-W1-FACJOIN-001 backend exposes join facility verification endpoint', () => {
  const source = read(staffRoutePath);
  assert.ok(
    source.includes("router.post('/join-requests/verify'"),
    'Expected POST /api/staff/join-requests/verify route to exist in staff.ts'
  );
});

test('QA-W1-FACJOIN-002 backend exposes join facility submission endpoint', () => {
  const source = read(staffRoutePath);
  assert.ok(
    source.includes("router.post('/join-requests'"),
    'Expected POST /api/staff/join-requests route to exist in staff.ts'
  );
});

test('QA-W1-FACJOIN-003 join facility UI is wired to backend join-request API endpoints', () => {
  const uiSource = read(joinFacilityDialogPath);
  const apiSource = read(staffApiPath);
  assert.match(uiSource, /staffApi\.verifyJoinFacilityClinicCode\(/);
  assert.match(uiSource, /staffApi\.submitJoinFacilityRequest\(/);
  assert.match(apiSource, /\/staff\/join-requests\/verify/);
  assert.match(apiSource, /\/staff\/join-requests/);
});

test('QA-W1-PASS-001 register-staff schema enforces 12+ length and complexity', () => {
  const source = read(authRoutePath);
  assert.match(source, /\.min\(12,\s*'Password must be at least 12 characters long'\)/);
  assert.match(source, /\.regex\(\/\[a-z\]\//);
  assert.match(source, /\.regex\(\/\[A-Z\]\//);
  assert.match(source, /\.regex\(\/\[0-9\]\//);
  assert.match(source, /\.regex\(\/\[\^A-Za-z0-9\]\//);
});

test('QA-W1-CONFIG-001 verification code secret must not fallback to service key or default literal', () => {
  const source = read(authRoutePath);
  assert.equal(
    source.includes('process.env.SUPABASE_SERVICE_ROLE_KEY'),
    false,
    'Verification code secret must not fallback to SUPABASE_SERVICE_ROLE_KEY'
  );
  assert.equal(
    source.includes("'development-verification-secret'"),
    false,
    'Verification code secret must not fallback to a hardcoded development literal'
  );
});

test('QA-W1-CONFIG-002 non-dev startup validates EMAIL_VERIFICATION_CODE_SECRET', () => {
  const source = read(authRoutePath);
  assert.ok(
    source.includes('EMAIL_VERIFICATION_CODE_SECRET is required'),
    'Expected explicit non-dev validation for EMAIL_VERIFICATION_CODE_SECRET'
  );
});

test('QA-W1-INV-001 IssueOrders mutations use inventoryApi wrappers and avoid direct table writes', () => {
  const source = read(issueOrdersPath);
  assert.match(source, /inventoryApi\.createIssueOrder\(/);
  assert.match(source, /inventoryApi\.updateIssueOrder\(/);
  assert.match(source, /inventoryApi\.addIssueOrderItem\(/);
  assert.match(source, /inventoryApi\.deleteIssueOrderItem\(/);
  assert.match(source, /inventoryApi\.dispatchIssueOrder\(/);
  assert.doesNotMatch(source, /\.from\('issue_orders'\)\s*\.(insert|update|upsert|delete)/);
  assert.doesNotMatch(source, /\.from\('issue_order_items'\)\s*\.(insert|update|upsert|delete)/);
});

test('QA-W1-INV-002 LossAdjustments mutations use inventoryApi wrappers and avoid direct table writes', () => {
  const source = read(lossAdjustmentsPath);
  assert.match(source, /inventoryApi\.createLossAdjustment\(/);
  assert.match(source, /inventoryApi\.updateLossAdjustment\(/);
  assert.match(source, /inventoryApi\.approveLossAdjustment\(/);
  assert.doesNotMatch(source, /\.from\('loss_adjustments'\)\s*\.(insert|update|upsert|delete)/);
});

test('QA-W1-DOCTOR-001 DoctorDashboard status mutations route through doctorApi wrappers', () => {
  const source = read(doctorDashboardPath);
  assert.match(source, /doctorApi\.updateVisitStatus\(/);
  assert.match(source, /doctorApi\.deleteLabOrder\(/);
  assert.doesNotMatch(source, /apiClient\.patch\([^)]*\/patients\/visits\//);
  assert.doesNotMatch(source, /apiClient\.delete\([^)]*\/orders\/lab\//);
});

test('QA-P0-INV-001 inventory dispatch has explicit already-dispatched idempotency guard', () => {
  const serviceSource = read(inventoryMutationServicePath);
  const migrationSource = read(inventoryTransactionalMigrationPath);
  assert.match(serviceSource, /rpc\(\s*'backend_dispatch_issue_order'/);
  assert.match(migrationSource, /IF v_order\.status = 'issued'::public\.issue_order_status_enum THEN/);
  assert.match(migrationSource, /'already_dispatched', true/);
});

test('QA-P0-INV-002 inventory loss-approval has explicit already-approved idempotency guard', () => {
  const serviceSource = read(inventoryMutationServicePath);
  const migrationSource = read(inventoryTransactionalMigrationPath);
  assert.match(serviceSource, /rpc\(\s*'backend_approve_loss_adjustment'/);
  assert.match(migrationSource, /IF v_adjustment\.status = 'approved'::public\.loss_adjustment_status_enum THEN/);
  assert.match(migrationSource, /'already_approved', true/);
});

test('QA-P0-INV-003 inventory dispatch update uses compare-and-set status predicate for double-submit safety', () => {
  const source = read(inventoryTransactionalMigrationPath);
  assert.match(
    source,
    /UPDATE public\.issue_orders[\s\S]*?WHERE id = p_order_id[\s\S]*?AND status = 'draft'::public\.issue_order_status_enum;/,
    'Expected dispatch function CAS guard (status = draft) on issue_orders update'
  );
  assert.match(source, /IF NOT FOUND THEN[\s\S]*?'already_dispatched', true/);
});

test('QA-P0-INV-004 inventory loss-approval update uses compare-and-set status predicate for double-submit safety', () => {
  const source = read(inventoryTransactionalMigrationPath);
  assert.match(
    source,
    /UPDATE public\.loss_adjustments[\s\S]*?WHERE id = p_adjustment_id[\s\S]*?AND status IN \([\s\S]*?'draft'::public\.loss_adjustment_status_enum,[\s\S]*?'submitted'::public\.loss_adjustment_status_enum[\s\S]*?\);/,
    'Expected approval function CAS guard (status IN draft/submitted) on loss_adjustments update'
  );
  assert.match(source, /IF NOT FOUND THEN[\s\S]*?'already_approved', true/);
});

test('QA-P0-STAFF-001 staff approve path uses transactional RPC with pending-only CAS guard', () => {
  const source = read(staffRoutePath);
  const migrationSource = read(staffApprovalTransactionalMigrationPath);
  assert.match(source, /rpc\(\s*'backend_approve_staff_registration_request'/);
  assert.match(
    migrationSource,
    /UPDATE public\.staff_registration_requests[\s\S]*?WHERE id = v_request\.id[\s\S]*?AND status = 'pending';/,
    'Expected staff approval transactional function to enforce status = pending at write time'
  );
});

test('QA-P0-STAFF-002 staff reject path enforces pending-only transition at write time', () => {
  const source = read(staffRoutePath);
  assert.match(
    source,
    /\.from\('staff_registration_requests'\)[\s\S]*?\.update\([\s\S]*?status:\s*'rejected'[\s\S]*?\)[\s\S]*?\.eq\('id', request\.id\)[\s\S]*?\.eq\('status', 'pending'\)/,
    'Expected staff reject update query to enforce status = pending'
  );
});

test('QA-P0-VISIT-001 visit transition safety defines forbidden-transition guardrails', () => {
  const source = read(patientVisitStatusServicePath);
  assert.match(source, /const transitionGuardMap: Record<string, Set<string>> = \{/);
  assert.match(source, /'CONFLICT_INVALID_VISIT_STATUS_TRANSITION'/);
});

test('QA-P0-VISIT-002 visit transition safety defines role-based restriction guardrails', () => {
  const source = read(patientVisitStatusServicePath);
  assert.match(source, /const statusRoleGuards: Record<string, Set<string>> = \{/);
  assert.match(source, /'PERM_VISIT_STATUS_TRANSITION_FORBIDDEN'/);
});

test('QA-P0-VISIT-003 visit transition safety enforces terminal-state protection', () => {
  const source = read(patientVisitStatusServicePath);
  assert.match(source, /const terminalStatuses = new Set\(\['discharged'\]\)/);
  assert.match(source, /'CONFLICT_TERMINAL_VISIT_STATUS'/);
});

test('QA-P0-INV-005 inventory path-param UUID validation failures return stable validation codes', () => {
  const source = read(inventoryRoutePath);
  assert.match(source, /const uuidParamSchema = z\.string\(\)\.uuid\(\);/);
  assert.match(source, /resolveRequiredUuidParam/);
  assert.match(source, /'VALIDATION_INVALID_ISSUE_ORDER_ID'/);
  assert.match(source, /'VALIDATION_INVALID_ISSUE_ORDER_ITEM_ID'/);
  assert.match(source, /'VALIDATION_INVALID_LOSS_ADJUSTMENT_ID'/);
});

test('QA-P0-INV-006 issue-order ending balance is server-derived and not client-controlled', () => {
  const source = read(inventoryMutationServicePath);
  assert.match(source, /const computeIssueOrderEndingBalance = \(payload: IssueOrderItemMutationPayload\) =>/);
  assert.match(source, /const endingBalance = computeIssueOrderEndingBalance\(payload\);/);
  assert.match(source, /ending_balance: endingBalance,/);
  assert.doesNotMatch(source, /payload\.ending_balance/);
});

test('QA-P0-CLIN-001 admitted transition requires ward\/bed\/admittedAt\/provider metadata', () => {
  const source = read(patientVisitStatusServicePath);
  assert.match(source, /if \(nextStatus === 'admitted'\)/);
  assert.match(source, /'VALIDATION_REQUIRED_ADMISSION_METADATA'/);
  assert.match(source, /missing\.push\('provider'\)/);
  assert.match(source, /missing\.push\('admissionWard'\)/);
  assert.match(source, /missing\.push\('admissionBed'\)/);
  assert.match(source, /missing\.push\('admittedAt'\)/);
});

test('QA-P0-CLIN-002 discharged transition requires discharge metadata completeness', () => {
  const source = read(patientVisitStatusServicePath);
  assert.match(source, /if \(nextStatus === 'discharged'\)/);
  assert.match(source, /'VALIDATION_REQUIRED_DISCHARGE_METADATA'/);
  assert.match(source, /assessmentCompleted !== true/);
  assert.match(source, /routingStatus !== 'completed'/);
});

test('QA-P0-CLIN-003 role\/state transition rules remain enforced', () => {
  const source = read(patientVisitStatusServicePath);
  assert.match(source, /const statusRoleGuards: Record<string, Set<string>> = \{/);
  assert.match(source, /const transitionGuardMap: Record<string, Set<string>> = \{/);
  assert.match(source, /const terminalStatuses = new Set\(\['discharged'\]\)/);
});
