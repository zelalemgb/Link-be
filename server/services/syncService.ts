import crypto from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import type { SyncOpType } from '../../shared/contracts/sync';

export type SyncContractErrorCode =
  | `AUTH_${string}`
  | `PERM_${string}`
  | `TENANT_${string}`
  | `VALIDATION_${string}`
  | `CONFLICT_${string}`;

export type SyncResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: SyncContractErrorCode; message: string };

type SyncFailure = {
  ok: false;
  status: number;
  code: SyncContractErrorCode;
  message: string;
};

export type SyncActor = {
  authUserId?: string;
  profileId?: string;
  tenantId?: string;
  facilityId?: string;
  role?: string;
  requestId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const SYNC_MAX_OPS = 500;
const SYNC_DEFAULT_PULL_LIMIT = 200;
const SYNC_MAX_PULL_LIMIT = 500;

const opTypeSchema = z.enum(['upsert', 'delete']) satisfies z.ZodType<SyncOpType>;

const syncOpSchema = z
  .object({
    opId: z.string().uuid(),
    entityType: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/i),
    entityId: z.string().uuid(),
    opType: opTypeSchema,
    data: z.record(z.any()).optional().nullable(),
    clientCreatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const syncPushSchema = z
  .object({
    facilityId: z.string().uuid(),
    deviceId: z.string().trim().min(1).max(128),
    ops: z.array(syncOpSchema).min(1).max(SYNC_MAX_OPS),
  })
  .strict();

const syncPullQuerySchema = z
  .object({
    facilityId: z.string().uuid().optional(),
    cursor: z.string().trim().optional(),
    limit: z.coerce.number().int().min(1).max(SYNC_MAX_PULL_LIMIT).optional(),
  })
  .strict();

const contractError = (
  status: number,
  code: SyncContractErrorCode,
  message: string
): SyncFailure => ({
  ok: false,
  status,
  code,
  message,
});

const normalizeRole = (role?: string | null) => (role || '').trim().toLowerCase();

const ensureActorScope = (
  actor: SyncActor
): { ok: true; data: Required<Pick<SyncActor, 'tenantId' | 'facilityId' | 'authUserId' | 'role'>> & SyncActor } | SyncFailure => {
  const role = normalizeRole(actor.role);
  if (!actor.authUserId) {
    return contractError(401, 'AUTH_MISSING_USER_CONTEXT', 'Missing user context');
  }
  if (role !== 'super_admin') {
    if (!actor.tenantId || !actor.facilityId) {
      return contractError(403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing tenant or facility context');
    }
  } else {
    // For now, super_admin sync must still pass facilityId+tenantId via request validation paths.
    if (!actor.tenantId || !actor.facilityId) {
      return contractError(403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing tenant or facility context');
    }
  }

  return {
    ok: true,
    data: {
      ...actor,
      authUserId: actor.authUserId,
      tenantId: actor.tenantId,
      facilityId: actor.facilityId,
      role: role || 'staff',
    },
  };
};

const ensureFacilityInTenant = async ({
  facilityId,
  tenantId,
}: {
  facilityId: string;
  tenantId: string;
}): Promise<SyncResult<{ id: string }>> => {
  const { data: facility, error } = await supabaseAdmin
    .from('facilities')
    .select('id, tenant_id')
    .eq('id', facilityId)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  if (!facility) {
    return contractError(404, 'VALIDATION_FACILITY_NOT_FOUND', 'Facility not found');
  }
  if (facility.tenant_id !== tenantId) {
    return contractError(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Facility is outside your tenant scope');
  }
  return { ok: true, data: { id: facility.id } };
};

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const output: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      output[key] = canonicalizeJson(record[key]);
    }
    return output;
  }
  return value;
};

const hashOpPayload = (payload: Record<string, unknown>) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(payload)))
    .digest('hex');

export const ingestSyncPush = async ({
  actor,
  payload,
}: {
  actor: SyncActor;
  payload: unknown;
}): Promise<
  SyncResult<{
    serverTime: string;
    results: Array<{ opId: string; status: 'ingested' | 'duplicate' }>;
  }>
> => {
  try {
    const actorScope = ensureActorScope(actor);
    if (actorScope.ok === false) return actorScope;
    const scopedActor = actorScope.data;

    const parsed = syncPushSchema.safeParse(payload);
    if (!parsed.success) {
      return contractError(
        400,
        'VALIDATION_INVALID_SYNC_PUSH_PAYLOAD',
        parsed.error.issues[0]?.message || 'Invalid sync push payload'
      );
    }

    // Facility isolation: clinicians may sync only their facility (super_admin is still scoped by actor facility today).
    if (parsed.data.facilityId !== scopedActor.facilityId) {
      return contractError(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Facility is outside your facility scope');
    }

    const facilityScope = await ensureFacilityInTenant({
      facilityId: parsed.data.facilityId,
      tenantId: scopedActor.tenantId,
    });
    if (facilityScope.ok === false) return facilityScope;

    const opsNormalized = parsed.data.ops.map((op) => ({
      opId: op.opId,
      entityType: op.entityType.trim().toLowerCase(),
      entityId: op.entityId,
      opType: op.opType,
      data: (op.data as Record<string, unknown> | null | undefined) || null,
      clientCreatedAt: op.clientCreatedAt,
    }));

    const opIds = opsNormalized.map((op) => op.opId);

    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from('sync_op_ledger')
      .select('op_id, payload_hash')
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', parsed.data.facilityId)
      .in('op_id', opIds);
    if (existingError) {
      throw new Error(existingError.message);
    }

    const existingByOpId = new Map<string, { payload_hash: string }>();
    (existingRows || []).forEach((row: any) => {
      if (row?.op_id) {
        existingByOpId.set(String(row.op_id), { payload_hash: String(row.payload_hash || '') });
      }
    });

    const results: Array<{ opId: string; status: 'ingested' | 'duplicate' }> = [];
    const inserts: Array<{
      tenant_id: string;
      facility_id: string;
      op_id: string;
      device_id: string;
      payload: Record<string, unknown>;
      payload_hash: string;
    }> = [];

    for (const op of opsNormalized) {
      const payloadRow: Record<string, unknown> = {
        opId: op.opId,
        entityType: op.entityType,
        entityId: op.entityId,
        opType: op.opType,
        data: op.data,
        clientCreatedAt: op.clientCreatedAt,
      };
      const payloadHash = hashOpPayload(payloadRow);

      const existing = existingByOpId.get(op.opId);
      if (existing) {
        if (existing.payload_hash && existing.payload_hash !== payloadHash) {
          return contractError(
            409,
            'CONFLICT_SYNC_OP_ID_COLLISION',
            `opId ${op.opId} already exists with a different payload`
          );
        }
        results.push({ opId: op.opId, status: 'duplicate' });
        continue;
      }

      inserts.push({
        tenant_id: scopedActor.tenantId,
        facility_id: parsed.data.facilityId,
        op_id: op.opId,
        device_id: parsed.data.deviceId,
        payload: payloadRow,
        payload_hash: payloadHash,
      });
      results.push({ opId: op.opId, status: 'ingested' });
    }

    if (inserts.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from('sync_op_ledger')
        .upsert(inserts, {
          onConflict: 'tenant_id,facility_id,op_id',
          ignoreDuplicates: true,
        });
      if (insertError) {
        throw new Error(insertError.message);
      }
    }

    return {
      ok: true,
      data: {
        serverTime: new Date().toISOString(),
        results,
      },
    };
  } catch (error: any) {
    console.error('ingestSyncPush service error:', error?.message || error);
    return contractError(500, 'CONFLICT_SYNC_PUSH_FAILED', 'Failed to ingest sync operations');
  }
};

const parseCursor = (raw: string | undefined) => {
  const normalized = (raw || '').trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
};

export const loadSyncPull = async ({
  actor,
  query,
}: {
  actor: SyncActor;
  query: unknown;
}): Promise<
  SyncResult<{
    serverTime: string;
    cursor: string | null;
    hasMore: boolean;
    ops: Array<{
      seq: number;
      opId: string;
      deviceId: string;
      entityType: string;
      entityId: string;
      opType: SyncOpType;
      data: Record<string, unknown> | null;
      clientCreatedAt: string;
      serverCreatedAt: string;
    }>;
  }>
> => {
  try {
    const actorScope = ensureActorScope(actor);
    if (actorScope.ok === false) return actorScope;
    const scopedActor = actorScope.data;

    const parsed = syncPullQuerySchema.safeParse(query || {});
    if (!parsed.success) {
      return contractError(
        400,
        'VALIDATION_INVALID_SYNC_PULL_QUERY',
        parsed.error.issues[0]?.message || 'Invalid sync pull query'
      );
    }

    const facilityId = parsed.data.facilityId || scopedActor.facilityId;
    if (!facilityId) {
      return contractError(403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing facility context');
    }

    if (facilityId !== scopedActor.facilityId) {
      return contractError(403, 'TENANT_RESOURCE_SCOPE_VIOLATION', 'Facility is outside your facility scope');
    }

    const cursor = parseCursor(parsed.data.cursor);
    if (parsed.data.cursor && cursor === null) {
      return contractError(400, 'VALIDATION_INVALID_CURSOR', 'cursor must be a non-negative integer string');
    }

    const limit = parsed.data.limit || SYNC_DEFAULT_PULL_LIMIT;

    const facilityScope = await ensureFacilityInTenant({
      facilityId,
      tenantId: scopedActor.tenantId,
    });
    if (facilityScope.ok === false) return facilityScope;

    let queryBuilder = supabaseAdmin
      .from('sync_op_ledger')
      .select('seq, op_id, device_id, payload, created_at')
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', facilityId)
      .order('seq', { ascending: true })
      .limit(Math.min(limit + 1, SYNC_MAX_PULL_LIMIT + 1));

    if (typeof cursor === 'number') {
      queryBuilder = queryBuilder.gt('seq', cursor);
    }

    const { data: rows, error } = await queryBuilder;
    if (error) {
      throw new Error(error.message);
    }

    const allRows = (rows || []) as any[];
    const hasMore = allRows.length > limit;
    const page = hasMore ? allRows.slice(0, limit) : allRows;
    const nextCursor = page.length > 0 ? String(page[page.length - 1].seq) : (cursor !== null ? String(cursor) : null);

    const ops = page.map((row) => {
      const payload = (row.payload || {}) as Record<string, unknown>;
      return {
        seq: Number(row.seq),
        opId: String(row.op_id),
        deviceId: String(row.device_id || ''),
        entityType: String(payload.entityType || ''),
        entityId: String(payload.entityId || ''),
        opType: String(payload.opType || 'upsert') as SyncOpType,
        data: (payload.data as Record<string, unknown> | null | undefined) || null,
        clientCreatedAt: String(payload.clientCreatedAt || ''),
        serverCreatedAt: String(row.created_at || ''),
      };
    });

    return {
      ok: true,
      data: {
        serverTime: new Date().toISOString(),
        cursor: nextCursor,
        hasMore,
        ops,
      },
    };
  } catch (error: any) {
    console.error('loadSyncPull service error:', error?.message || error);
    return contractError(500, 'CONFLICT_SYNC_PULL_FAILED', 'Failed to load sync deltas');
  }
};

