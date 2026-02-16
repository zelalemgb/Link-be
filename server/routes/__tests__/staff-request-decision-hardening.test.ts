import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const staffRoutePath = path.resolve(__dirname, '../staff.ts');
const staffApprovalMigrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260215143000_transactional_staff_request_approval.sql'
);
const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadAuditModules = async () => {
  ensureSupabaseEnv();
  const auditLogService = await import('../../services/audit-log');
  const configModule = await import('../../config/supabase');
  return {
    auditLogService,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('staff request approve uses transactional RPC and DB compare-and-set pending guard', () => {
  const routeSource = read(staffRoutePath);
  const migrationSource = read(staffApprovalMigrationPath);

  assert.match(routeSource, /rpc\(\s*'backend_approve_staff_registration_request'/);
  assert.match(migrationSource, /IF lower\(trim\(COALESCE\(v_request\.status, ''\)\)\) <> 'pending' THEN/);
  assert.match(
    migrationSource,
    /UPDATE public\.staff_registration_requests[\s\S]*WHERE id = v_request\.id[\s\S]*AND status = 'pending';/
  );
});

test('staff request approval RPC uses idempotent user_roles upsert guard', () => {
  const migrationSource = read(staffApprovalMigrationPath);
  assert.match(migrationSource, /INSERT INTO public\.user_roles/);
  assert.match(migrationSource, /ON CONFLICT \(user_id, role_id, facility_id\) DO UPDATE/);
});

test('staff request approval RPC inserts audit row in the same transactional function', () => {
  const migrationSource = read(staffApprovalMigrationPath);
  assert.match(migrationSource, /INSERT INTO public\.audit_log/);
  assert.match(migrationSource, /'approve_staff_registration_request'/);
});

test('staff request approval RPC has rollback-test hook for induced mid-flow failure', () => {
  const migrationSource = read(staffApprovalMigrationPath);
  assert.match(migrationSource, /p_debug_fail_after_role_upsert boolean DEFAULT false/);
  assert.match(migrationSource, /RAISE EXCEPTION 'DEBUG_APPROVAL_FAILURE_AFTER_ROLE_UPSERT';/);
});

test('join-request verification endpoint emits structured audit event', () => {
  const source = read(staffRoutePath);
  assert.match(source, /action:\s*'verify_staff_join_request'/);
  assert.match(source, /clinicCode:\s*normalizedClinicCode/);
});

test('staff reject privileged write enforces strict-audit mode with durable outbox fallback metadata', () => {
  const source = read(staffRoutePath);
  assert.match(source, /router\.post\('\/admin\/requests\/:id\/reject'/);
  assert.match(source, /action:\s*'reject_staff_registration_request'/);
  assert.match(source, /strict:\s*true/);
  assert.match(source, /outboxEventType:\s*'audit\.staff_request\.reject\.write_failed'/);
  assert.match(source, /outboxAggregateType:\s*'staff_registration_request'/);
});

test('staff approval privileged write keeps atomic contract to prevent partial writes on audit failure', () => {
  const routeSource = read(staffRoutePath);
  const migrationSource = read(staffApprovalMigrationPath);

  assert.match(routeSource, /rpc\(\s*'backend_approve_staff_registration_request'/);
  const approveRouteMatch = routeSource.match(
    /router\.post\('\/admin\/requests\/:id\/approve'[\s\S]*?return res\.json\(\{ success: true \}\);[\s\S]*?\}\);/
  );
  assert.ok(approveRouteMatch, 'Expected approve route to exist');
  const approveRouteSource = approveRouteMatch?.[0] || '';
  assert.doesNotMatch(
    approveRouteSource,
    /recordAuditEvent\(/,
    'Approval route should rely on RPC transaction contract (not post-commit app-layer audit write)'
  );

  assert.match(migrationSource, /UPDATE public\.users/);
  assert.match(migrationSource, /INSERT INTO public\.user_roles/);
  assert.match(
    migrationSource,
    /UPDATE public\.staff_registration_requests[\s\S]*WHERE id = v_request\.id[\s\S]*AND status = 'pending';/
  );
  assert.match(migrationSource, /INSERT INTO public\.audit_log/);
  assert.match(
    migrationSource,
    /EXCEPTION WHEN OTHERS THEN[\s\S]*RAISE EXCEPTION 'AUDIT_DURABILITY_FAILURE';/,
    'Audit insert failures must abort the transaction with AUDIT_DURABILITY_FAILURE (no swallow/continue behavior)'
  );
});

test(
  'forced strict-audit failure throws deterministic error when durable fallback cannot be persisted',
  { concurrency: false },
  async () => {
    const { auditLogService, supabaseAdmin } = await loadAuditModules();
    const originalFrom = (supabaseAdmin as any).from;
    const originalAuditEnabled = process.env.AUDIT_LOG_ENABLED;

    const privilegedEvent = {
      action: 'reject_staff_registration_request',
      eventType: 'update',
      entityType: 'staff_registration_request',
      tenantId: '10000000-0000-4000-8000-000000000001',
      facilityId: '20000000-0000-4000-8000-000000000001',
      actorUserId: '30000000-0000-4000-8000-000000000001',
      actorRole: 'clinic_admin',
      entityId: '40000000-0000-4000-8000-000000000001',
      requestId: '50000000-0000-4000-8000-000000000001',
    };

    try {
      process.env.AUDIT_LOG_ENABLED = 'true';

      (supabaseAdmin as any).from = () => ({
        insert: async () => ({ data: null, error: { message: 'forced strict audit failure' } }),
      });

      await assert.rejects(
        () =>
          auditLogService.recordAuditEvent(privilegedEvent, {
            strict: true,
            outboxEventType: 'audit.staff_request.reject.write_failed',
            outboxAggregateType: 'staff_registration_request',
            outboxAggregateId: privilegedEvent.entityId,
          }),
        /AUDIT_DURABILITY_FAILURE/
      );
    } finally {
      (supabaseAdmin as any).from = originalFrom;
      process.env.AUDIT_LOG_ENABLED = originalAuditEnabled;
    }
  }
);

test(
  'forced audit_log insert failure in strict mode persists durable outbox event and does not throw',
  { concurrency: false },
  async () => {
    const { auditLogService, supabaseAdmin } = await loadAuditModules();
    const originalFrom = (supabaseAdmin as any).from;
    const originalAuditEnabled = process.env.AUDIT_LOG_ENABLED;

    let outboxInsertPayload: Record<string, any> | null = null;

    const privilegedEvent = {
      action: 'reject_staff_registration_request',
      eventType: 'update',
      entityType: 'staff_registration_request',
      tenantId: '10000000-0000-4000-8000-000000000001',
      facilityId: '20000000-0000-4000-8000-000000000001',
      actorUserId: '30000000-0000-4000-8000-000000000001',
      actorRole: 'clinic_admin',
      entityId: '40000000-0000-4000-8000-000000000001',
      requestId: '50000000-0000-4000-8000-000000000001',
    };

    try {
      process.env.AUDIT_LOG_ENABLED = 'true';

      (supabaseAdmin as any).from = (table: string) => ({
        insert: async (payload: Record<string, any>) => {
          if (table === 'audit_log') {
            return { data: null, error: { message: 'forced audit insert failure' } };
          }
          if (table === 'outbox_events') {
            outboxInsertPayload = payload;
            return { data: { id: 'outbox-1' }, error: null };
          }
          return { data: null, error: null };
        },
      });

      await auditLogService.recordAuditEvent(privilegedEvent, {
        strict: true,
        outboxEventType: 'audit.staff_request.reject.write_failed',
        outboxAggregateType: 'staff_registration_request',
        outboxAggregateId: privilegedEvent.entityId,
      });

      assert.ok(outboxInsertPayload, 'Expected strict mode to persist outbox event when audit insert fails');
      assert.equal(outboxInsertPayload?.event_type, 'audit.staff_request.reject.write_failed');
      assert.equal(outboxInsertPayload?.aggregate_type, 'staff_registration_request');
      assert.equal(outboxInsertPayload?.aggregate_id, privilegedEvent.entityId);
      assert.equal(outboxInsertPayload?.tenant_id, privilegedEvent.tenantId);
    } finally {
      (supabaseAdmin as any).from = originalFrom;
      process.env.AUDIT_LOG_ENABLED = originalAuditEnabled;
    }
  }
);
