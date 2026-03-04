// =============================================================================
// Sync contract types — shared between server and mobile (W2-03)
// =============================================================================

export const SYNC_OP_TYPES = ['upsert', 'delete'] as const;
export type SyncOpType = (typeof SYNC_OP_TYPES)[number];

// ─── Push ─────────────────────────────────────────────────────────────────────

export type SyncOp = {
  /** Client-generated UUID — idempotency key. */
  opId: string;
  entityType: string;
  entityId: string;
  opType: SyncOpType;
  /** Full entity snapshot at time of op creation. Must include updated_at for LWW. */
  data?: Record<string, unknown> | null;
  /** ISO timestamp when this op was created on the client. */
  clientCreatedAt: string;
};

export type SyncPushRequest = {
  facilityId: string;
  deviceId: string;
  ops: SyncOp[];
};

export type SyncOpResultStatus = 'ingested' | 'duplicate' | 'conflict';

export type SyncOpResult = {
  opId: string;
  /** ingested = applied or skipped (unknown entity type); conflict = server won LWW */
  status: SyncOpResultStatus;
  /** Only present when status = 'conflict' */
  conflictReason?: string;
};

export type SyncPushResponse = {
  serverTime: string;
  results: SyncOpResult[];
};

// ─── Pull ─────────────────────────────────────────────────────────────────────

export type SyncPullRequest = {
  facilityId: string;
  cursor?: string | null;
  limit?: number | null;
};

export type SyncPulledOp = {
  seq: number;
  opId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  opType: SyncOpType;
  data: Record<string, unknown> | null;
  clientCreatedAt: string;
  serverCreatedAt: string;
};

export type SyncTombstone = {
  entityType: string;
  entityId: string;
  deletedAt: string;
  deletedRevision: number;
};

export type SyncPullResponse = {
  serverTime: string;
  /** Opaque cursor to pass on the next pull request. Store and advance. */
  cursor: string | null;
  hasMore: boolean;
  ops: SyncPulledOp[];
  /** Entities deleted since the last pull. Apply these as local soft-deletes. */
  tombstones: SyncTombstone[];
};

// ─── Error ────────────────────────────────────────────────────────────────────

export type SyncContractError = {
  /** Stable, machine-readable error code. Namespaced: AUTH_* | PERM_* | TENANT_* | VALIDATION_* | CONFLICT_* */
  code: string;
  message: string;
};

// ─── Stable error code catalogue (W2-BE-023) ──────────────────────────────────
// AUTH_*       — token / session issues
// PERM_*       — role / profile issues
// TENANT_*     — tenant/facility scoping violations
// VALIDATION_* — malformed request payloads or query params
// CONFLICT_*   — sync-specific runtime errors

export const SYNC_ERROR_CODES = {
  // Auth
  AUTH_MISSING_BEARER_TOKEN:        'AUTH_MISSING_BEARER_TOKEN',
  AUTH_INVALID_TOKEN:               'AUTH_INVALID_TOKEN',
  AUTH_MISSING_USER_CONTEXT:        'AUTH_MISSING_USER_CONTEXT',
  // Permission
  PERM_MISSING_USER_PROFILE:        'PERM_MISSING_USER_PROFILE',
  PERM_INSUFFICIENT_ROLE:           'PERM_INSUFFICIENT_ROLE',
  // Tenant / facility
  TENANT_MISSING_SCOPE_CONTEXT:     'TENANT_MISSING_SCOPE_CONTEXT',
  TENANT_RESOURCE_SCOPE_VIOLATION:  'TENANT_RESOURCE_SCOPE_VIOLATION',
  // Validation
  VALIDATION_INVALID_SYNC_PUSH_PAYLOAD: 'VALIDATION_INVALID_SYNC_PUSH_PAYLOAD',
  VALIDATION_INVALID_SYNC_PULL_QUERY:   'VALIDATION_INVALID_SYNC_PULL_QUERY',
  VALIDATION_INVALID_CURSOR:            'VALIDATION_INVALID_CURSOR',
  VALIDATION_FACILITY_NOT_FOUND:        'VALIDATION_FACILITY_NOT_FOUND',
  // Conflict / runtime
  CONFLICT_SYNC_OP_ID_COLLISION:    'CONFLICT_SYNC_OP_ID_COLLISION',
  CONFLICT_SYNC_PUSH_FAILED:        'CONFLICT_SYNC_PUSH_FAILED',
  CONFLICT_SYNC_PULL_FAILED:        'CONFLICT_SYNC_PULL_FAILED',
  CONFLICT_AUTH_FAILED:             'CONFLICT_AUTH_FAILED',
} as const;

export type SyncErrorCode = typeof SYNC_ERROR_CODES[keyof typeof SYNC_ERROR_CODES];
