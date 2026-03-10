import test from 'node:test';
import assert from 'node:assert/strict';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const auditLogService = await import('../../services/audit-log');
  const configModule = await import('../../config/supabase');
  return {
    auditLogService,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

const baseEvent = {
  action: 'update_staff_roles',
  eventType: 'update',
  entityType: 'user_roles',
  tenantId: '10000000-0000-4000-8000-000000000001',
  facilityId: '20000000-0000-4000-8000-000000000001',
  actorUserId: '30000000-0000-4000-8000-000000000001',
  actorRole: 'clinic_admin',
  entityId: '40000000-0000-4000-8000-000000000001',
  requestId: '50000000-0000-4000-8000-000000000001',
};

test('strict audit mode writes durable outbox fallback when audit insert fails', async () => {
  const { auditLogService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuditEnabled = process.env.AUDIT_LOG_ENABLED;

  let outboxInsertPayload: Record<string, any> | null = null;

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

    await auditLogService.recordAuditEvent(baseEvent, {
      strict: true,
      outboxEventType: 'audit.staff_roles.update.write_failed',
      outboxAggregateType: 'user_roles',
      outboxAggregateId: baseEvent.entityId,
    });

    assert.ok(outboxInsertPayload, 'Expected strict mode to write outbox fallback event');
    assert.equal(outboxInsertPayload?.event_type, 'audit.staff_roles.update.write_failed');
    assert.equal(outboxInsertPayload?.aggregate_type, 'user_roles');
    assert.equal(outboxInsertPayload?.aggregate_id, baseEvent.entityId);
    assert.equal(outboxInsertPayload?.tenant_id, baseEvent.tenantId);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    process.env.AUDIT_LOG_ENABLED = originalAuditEnabled;
  }
});

test('strict audit mode throws when both audit insert and outbox fallback fail', async () => {
  const { auditLogService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuditEnabled = process.env.AUDIT_LOG_ENABLED;

  try {
    process.env.AUDIT_LOG_ENABLED = 'true';

    (supabaseAdmin as any).from = () => ({
      insert: async () => ({ data: null, error: { message: 'forced failure' } }),
    });

    await assert.rejects(
      () =>
        auditLogService.recordAuditEvent(baseEvent, {
          strict: true,
          outboxEventType: 'audit.staff_roles.update.write_failed',
        }),
      /AUDIT_DURABILITY_FAILURE/
    );
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    process.env.AUDIT_LOG_ENABLED = originalAuditEnabled;
  }
});
