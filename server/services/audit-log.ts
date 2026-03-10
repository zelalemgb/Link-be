import { supabaseAdmin } from '../config/supabase';
import { recordAuditFailure } from './monitoring';
import { randomUUID } from 'node:crypto';

type AuditEvent = {
  action: string;
  eventType: string;
  entityType: string;
  tenantId: string;
  facilityId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  actorUsername?: string | null;
  actorIpAddress?: string | null;
  actorUserAgent?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  actionCategory?: string | null;
  complianceTags?: string[] | null;
  sensitivityLevel?: string | null;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
};

type AuditWriteOptions = {
  strict?: boolean;
  outboxEventType?: string;
  outboxAggregateType?: string;
  outboxAggregateId?: string | null;
};

export class AuditDurabilityError extends Error {
  readonly code = 'AUDIT_DURABILITY_FAILURE';

  constructor(message = 'Audit durability requirement failed') {
    super(message);
    this.name = 'AuditDurabilityError';
  }
}

export const isAuditDurabilityError = (value: unknown): value is AuditDurabilityError => {
  if (value instanceof AuditDurabilityError) {
    return true;
  }
  if (value instanceof Error) {
    return value.message.includes('AUDIT_DURABILITY_FAILURE') || value.message.includes('AUDIT_STRICT_WRITE_FAILED');
  }
  return false;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asUuidOrNull = (value?: string | null) => {
  if (!value) return null;
  const normalized = value.trim();
  return uuidPattern.test(normalized) ? normalized : null;
};

export const recordAuditEvent = async (event: AuditEvent, options: AuditWriteOptions = {}) => {
  const strict = options.strict === true;
  if (process.env.AUDIT_LOG_ENABLED === 'false' && !strict) return;

  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      action: event.action,
      event_type: event.eventType,
      entity_type: event.entityType,
      tenant_id: event.tenantId,
      facility_id: event.facilityId ?? null,
      actor_user_id: event.actorUserId ?? null,
      actor_role: event.actorRole ?? null,
      actor_username: event.actorUsername ?? null,
      actor_ip_address: event.actorIpAddress ?? null,
      actor_user_agent: event.actorUserAgent ?? null,
      entity_id: event.entityId ?? null,
      entity_name: event.entityName ?? null,
      action_category: event.actionCategory ?? null,
      compliance_tags: event.complianceTags ?? null,
      sensitivity_level: event.sensitivityLevel ?? null,
      metadata: event.metadata ?? null,
      request_id: asUuidOrNull(event.requestId),
    });
    if (error) {
      throw new Error(error.message || 'Audit log insert failed');
    }
  } catch (error: any) {
    console.error('Audit log insert failed:', error?.message || error);
    await recordAuditFailure(event.requestId || undefined);
    if (!strict) {
      return;
    }

    const outboxEventType = options.outboxEventType || 'audit_log.write_failed';
    const outboxAggregateType = options.outboxAggregateType || event.entityType || 'audit_log';
    const outboxAggregateId =
      asUuidOrNull(options.outboxAggregateId ?? event.entityId ?? null) || randomUUID();
    const correlationId = asUuidOrNull(event.requestId);
    const { error: outboxError } = await supabaseAdmin.from('outbox_events').insert({
      tenant_id: event.tenantId,
      event_type: outboxEventType,
      aggregate_type: outboxAggregateType,
      aggregate_id: outboxAggregateId,
      payload: {
        action: event.action,
        eventType: event.eventType,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        requestId: event.requestId ?? null,
        metadata: event.metadata ?? null,
      },
      metadata: {
        strict_audit: true,
        reason: 'audit_log_insert_failed',
        original_error: error?.message || 'Audit log insert failed',
      },
      correlation_id: correlationId,
      created_by: asUuidOrNull(event.actorUserId),
      status: 'pending',
    });

    if (outboxError) {
      throw new AuditDurabilityError(
        `AUDIT_DURABILITY_FAILURE: ${outboxError.message || 'Failed to persist audit fallback'}`
      );
    }
  }
};
