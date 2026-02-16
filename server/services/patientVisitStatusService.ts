import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { isAuditDurabilityError, recordAuditEvent } from './audit-log';

export type VisitStatusContractErrorCode =
  | `AUTH_${string}`
  | `PERM_${string}`
  | `TENANT_${string}`
  | `VALIDATION_${string}`
  | `CONFLICT_${string}`;

export type VisitStatusMutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: VisitStatusContractErrorCode; message: string };

type VisitStatusMutationFailure = {
  ok: false;
  status: number;
  code: VisitStatusContractErrorCode;
  message: string;
};

export type VisitStatusMutationActor = {
  authUserId?: string;
  profileId?: string;
  tenantId?: string;
  facilityId?: string;
  role?: string;
  requestId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const visitStatusValues = [
  'registered',
  'triage',
  'doctor',
  'lab',
  'pharmacy',
  'procedure',
  'at_triage',
  'vitals_taken',
  'with_doctor',
  'at_lab',
  'at_imaging',
  'paying_consultation',
  'paying_diagnosis',
  'paying_pharmacy',
  'at_pharmacy',
  'admitted',
  'discharged',
  'cancelled',
  'completed',
  'inpatient',
  'with_nurse',
  'waiting',
  'done',
] as const;

const routingStatusValues = ['completed', 'awaiting_routing', 'routing_in_progress'] as const;

const normalizeRole = (role?: string | null) => (role || '').trim().toLowerCase();
const normalizeStatus = (status?: string | null) => (status || '').trim().toLowerCase();

const statusRoleGuards: Record<string, Set<string>> = {
  with_doctor: new Set(['doctor', 'super_admin']),
  admitted: new Set(['doctor', 'inpatient_nurse', 'super_admin']),
  discharged: new Set(['super_admin']),
};

const transitionGuardMap: Record<string, Set<string>> = {
  with_doctor: new Set([
    'with_doctor',
    'at_lab',
    'at_imaging',
    'paying_diagnosis',
    'at_pharmacy',
    'paying_pharmacy',
    'admitted',
    'discharged',
  ]),
  admitted: new Set([
    'admitted',
    'discharged',
  ]),
  discharged: new Set(['discharged']),
};

const terminalStatuses = new Set(['discharged']);
const routingStatusValueSet = new Set<string>(routingStatusValues);
const strictAuditVisitStatuses = new Set(['admitted', 'discharged']);

export const visitStatusMutationSchema = z
  .object({
    status: z.enum(visitStatusValues),
    visitNotes: z.string().max(20000).optional().nullable(),
    provider: z.string().trim().min(1).max(160).optional().nullable(),
    assessmentCompleted: z.boolean().optional().nullable(),
    assessedAt: z.string().datetime({ offset: true }).optional().nullable(),
    assessedBy: z.string().uuid().optional().nullable(),
    admissionWard: z.string().trim().min(1).max(120).optional().nullable(),
    admissionBed: z.string().trim().min(1).max(120).optional().nullable(),
    admittedAt: z.string().datetime({ offset: true }).optional().nullable(),
    routingStatus: z.enum(routingStatusValues).optional().nullable(),
    statusUpdatedAt: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .strict();

export type VisitStatusMutationPayload = z.infer<typeof visitStatusMutationSchema>;

const isSuperAdmin = (role?: string) => (role || '').trim().toLowerCase() === 'super_admin';

const error = (
  status: number,
  code: VisitStatusContractErrorCode,
  message: string
): VisitStatusMutationFailure => ({
  ok: false,
  status,
  code,
  message,
});

const ensureVisitStatusAccess = (
  actor: VisitStatusMutationActor
): { ok: true; data: Required<Pick<VisitStatusMutationActor, 'authUserId'>> & VisitStatusMutationActor } | VisitStatusMutationFailure => {
  if (!actor.authUserId) {
    return error(401, 'AUTH_MISSING_USER_CONTEXT', 'Missing authenticated user context');
  }

  if (!isSuperAdmin(actor.role) && (!actor.tenantId || !actor.facilityId)) {
    return error(403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing facility or tenant context');
  }

  return {
    ok: true,
    data: {
      ...actor,
      authUserId: actor.authUserId,
    },
  };
};

const resolveEffectiveValue = <T>(payloadValue: T | undefined, existingValue: T): T =>
  payloadValue === undefined ? existingValue : payloadValue;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const validateTransitionRequiredMetadata = ({
  nextStatus,
  payload,
  visitRow,
}: {
  nextStatus: string;
  payload: VisitStatusMutationPayload;
  visitRow: {
    provider?: string | null;
    visit_notes?: string | null;
    assessment_completed?: boolean | null;
    assessed_at?: string | null;
    assessed_by?: string | null;
    admission_ward?: string | null;
    admission_bed?: string | null;
    admitted_at?: string | null;
    routing_status?: string | null;
  };
}): VisitStatusMutationFailure | null => {
  const provider = resolveEffectiveValue(payload.provider, visitRow.provider ?? null);
  const visitNotes = resolveEffectiveValue(payload.visitNotes, visitRow.visit_notes ?? null);
  const assessmentCompleted = resolveEffectiveValue(payload.assessmentCompleted, visitRow.assessment_completed ?? null);
  const assessedAt = resolveEffectiveValue(payload.assessedAt, visitRow.assessed_at ?? null);
  const assessedBy = resolveEffectiveValue(payload.assessedBy, visitRow.assessed_by ?? null);
  const admissionWard = resolveEffectiveValue(payload.admissionWard, visitRow.admission_ward ?? null);
  const admissionBed = resolveEffectiveValue(payload.admissionBed, visitRow.admission_bed ?? null);
  const admittedAt = resolveEffectiveValue(payload.admittedAt, visitRow.admitted_at ?? null);
  const routingStatus = resolveEffectiveValue(payload.routingStatus, visitRow.routing_status ?? null);

  if (nextStatus === 'admitted') {
    const missing: string[] = [];
    if (!isNonEmptyString(provider)) missing.push('provider');
    if (!isNonEmptyString(visitNotes)) missing.push('visitNotes');
    if (!isNonEmptyString(admissionWard)) missing.push('admissionWard');
    if (!isNonEmptyString(admissionBed)) missing.push('admissionBed');
    if (!isNonEmptyString(admittedAt)) missing.push('admittedAt');
    if (!isNonEmptyString(routingStatus) || !routingStatusValueSet.has(routingStatus)) missing.push('routingStatus');

    if (missing.length > 0) {
      return error(
        400,
        'VALIDATION_REQUIRED_ADMISSION_METADATA',
        `Admitted status requires: ${missing.join(', ')}`
      );
    }
  }

  if (nextStatus === 'discharged') {
    const missing: string[] = [];
    if (!isNonEmptyString(provider)) missing.push('provider');
    if (!isNonEmptyString(visitNotes)) missing.push('visitNotes');
    if (!isNonEmptyString(assessedAt)) missing.push('assessedAt');
    if (!isNonEmptyString(assessedBy)) missing.push('assessedBy');

    if (assessmentCompleted !== true) {
      return error(
        400,
        'VALIDATION_REQUIRED_DISCHARGE_METADATA',
        'Discharged status requires assessmentCompleted=true'
      );
    }
    if (missing.length > 0) {
      return error(
        400,
        'VALIDATION_REQUIRED_DISCHARGE_METADATA',
        `Discharged status requires: ${missing.join(', ')}`
      );
    }
    if (routingStatus !== 'completed') {
      return error(
        400,
        'VALIDATION_REQUIRED_DISCHARGE_METADATA',
        'Discharged status requires routingStatus=completed'
      );
    }
  }

  return null;
};

export const updateVisitStatusMutation = async ({
  actor,
  visitId,
  payload,
}: {
  actor: VisitStatusMutationActor;
  visitId: string;
  payload: VisitStatusMutationPayload;
}): Promise<VisitStatusMutationResult<{ success: boolean }>> => {
  try {
    const actorResult = ensureVisitStatusAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const { data: visitRow, error: visitLookupError } = await supabaseAdmin
      .from('visits')
      .select(
        'id, status, facility_id, tenant_id, provider, visit_notes, assessment_completed, assessed_at, assessed_by, admission_ward, admission_bed, admitted_at, routing_status'
      )
      .eq('id', visitId)
      .maybeSingle();

    if (visitLookupError) {
      throw new Error(visitLookupError.message);
    }
    if (!visitRow) {
      return error(404, 'VALIDATION_VISIT_NOT_FOUND', 'Visit not found');
    }

    if (scopedActor.facilityId && visitRow.facility_id !== scopedActor.facilityId) {
      return error(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Visit is outside your facility scope');
    }
    if (scopedActor.tenantId && visitRow.tenant_id !== scopedActor.tenantId) {
      return error(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Visit is outside your tenant scope');
    }

    const actorRole = normalizeRole(scopedActor.role);
    const currentStatus = normalizeStatus(visitRow.status);
    const nextStatus = normalizeStatus(payload.status);
    const roleGuard = statusRoleGuards[currentStatus];
    if (roleGuard && !roleGuard.has(actorRole)) {
      return error(
        403,
        'PERM_VISIT_STATUS_TRANSITION_FORBIDDEN',
        `Role ${actorRole || 'unknown'} is not authorized to mutate ${currentStatus} visits`
      );
    }

    if (terminalStatuses.has(currentStatus) && currentStatus !== nextStatus) {
      return error(
        409,
        'CONFLICT_TERMINAL_VISIT_STATUS',
        'Cannot transition a discharged visit to a non-terminal status'
      );
    }

    const transitionGuard = transitionGuardMap[currentStatus];
    if (transitionGuard && !transitionGuard.has(nextStatus)) {
      return error(
        409,
        'CONFLICT_INVALID_VISIT_STATUS_TRANSITION',
        `Invalid transition from ${currentStatus} to ${nextStatus}`
      );
    }
    if (currentStatus === 'admitted' && nextStatus === 'with_doctor') {
      return error(
        409,
        'CONFLICT_INVALID_VISIT_STATUS_TRANSITION',
        'Admitted visits cannot transition back to with_doctor via this endpoint'
      );
    }

    const requiredMetadataFailure = validateTransitionRequiredMetadata({
      nextStatus,
      payload,
      visitRow,
    });
    if (requiredMetadataFailure) {
      return requiredMetadataFailure;
    }

    const updates: Record<string, any> = {
      status: payload.status,
      status_updated_at: payload.statusUpdatedAt || new Date().toISOString(),
    };

    if (payload.visitNotes !== undefined) updates.visit_notes = payload.visitNotes;
    if (payload.provider !== undefined && payload.provider !== null) updates.provider = payload.provider;
    if (payload.assessmentCompleted !== undefined) updates.assessment_completed = payload.assessmentCompleted;
    if (payload.assessedAt !== undefined) updates.assessed_at = payload.assessedAt;
    if (payload.assessedBy !== undefined) updates.assessed_by = payload.assessedBy;
    if (payload.admissionWard !== undefined) updates.admission_ward = payload.admissionWard;
    if (payload.admissionBed !== undefined) updates.admission_bed = payload.admissionBed;
    if (payload.admittedAt !== undefined) updates.admitted_at = payload.admittedAt;
    if (payload.routingStatus !== undefined) updates.routing_status = payload.routingStatus;

    let updateQuery = supabaseAdmin.from('visits').update(updates).eq('id', visitId);
    if (scopedActor.facilityId) {
      updateQuery = updateQuery.eq('facility_id', scopedActor.facilityId);
    }
    if (scopedActor.tenantId) {
      updateQuery = updateQuery.eq('tenant_id', scopedActor.tenantId);
    }

    const { data: updatedVisit, error: updateError } = await updateQuery.select('id').maybeSingle();
    if (updateError) {
      throw new Error(updateError.message);
    }
    if (!updatedVisit?.id) {
      return error(409, 'CONFLICT_VISIT_STATUS_WRITE_NOT_APPLIED', 'Visit status update was not applied');
    }

    const resolvedTenantId = scopedActor.tenantId || visitRow.tenant_id;
    if (resolvedTenantId) {
      await recordAuditEvent({
        action: 'update_visit_status',
        eventType: 'update',
        entityType: 'visit',
        entityId: visitId,
        tenantId: resolvedTenantId,
        facilityId: scopedActor.facilityId || visitRow.facility_id || null,
        actorUserId: scopedActor.profileId || null,
        actorRole: scopedActor.role || null,
        actorIpAddress: scopedActor.ipAddress || null,
        actorUserAgent: scopedActor.userAgent || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: scopedActor.requestId || null,
        metadata: {
          previousStatus: visitRow.status || null,
          nextStatus: payload.status,
          changedFields: Object.keys(updates),
          provider: payload.provider ?? null,
          assessmentCompleted: payload.assessmentCompleted ?? null,
          assessedAt: payload.assessedAt ?? null,
          assessedBy: payload.assessedBy ?? null,
          admissionWard: payload.admissionWard ?? null,
          admissionBed: payload.admissionBed ?? null,
          admittedAt: payload.admittedAt ?? null,
          routingStatus: payload.routingStatus ?? null,
          statusUpdatedAt: updates.status_updated_at,
        },
      }, strictAuditVisitStatuses.has(nextStatus)
        ? {
            strict: true,
            outboxEventType: 'audit.patient_visit.status_update.write_failed',
            outboxAggregateType: 'visit',
            outboxAggregateId: visitId,
          }
        : undefined);
    }

    return { ok: true, data: { success: true } };
  } catch (serviceError: any) {
    console.error('updateVisitStatusMutation service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_VISIT_STATUS_UPDATE_FAILED', 'Failed to update visit status');
  }
};
