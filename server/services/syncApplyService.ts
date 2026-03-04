/**
 * syncApplyService.ts — W2-BE-022
 *
 * Last-Write-Wins (LWW) apply layer for sync push operations.
 *
 * Flow for each newly ingested op:
 *   1. Route by entityType (patients | visits)
 *   2. Fetch current server row (for LWW comparison)
 *   3. Compare client.updated_at vs server.updated_at
 *      - client >= server → CLIENT WINS → apply upsert / soft-delete
 *      - client <  server → SERVER WINS → write conflict_audit, skip apply
 *   4. For upserts: INSERT ON CONFLICT UPDATE with mapped W2 fields
 *   5. For deletes: UPDATE SET deleted_at = now()
 *      (the on_soft_delete_tombstone trigger auto-writes sync_tombstones)
 *   6. Return per-op ApplyResult for the push response
 *
 * Unknown entity types are accepted into the ledger but not applied to
 * domain tables (future-proofing for new entity types).
 */

import { supabaseAdmin } from '../config/supabase';
import type { SyncActor } from './syncService';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApplyStatus = 'applied' | 'conflict' | 'skipped';

export interface ApplyResult {
  opId: string;
  entityType: string;
  entityId: string;
  opType: string;
  status: ApplyStatus;
  conflictReason?: string;
}

export interface NormalizedOp {
  opId: string;
  entityType: string;
  entityId: string;
  opType: 'upsert' | 'delete';
  data: Record<string, unknown> | null;
  clientCreatedAt: string;
}

type ScopedActor = Required<Pick<SyncActor, 'tenantId' | 'facilityId' | 'authUserId'>> &
  SyncActor;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse an ISO string into milliseconds; returns null on invalid input. */
const toMs = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** Map mobile sex values to server gender column values. */
const mapSexToGender = (sex: unknown): string | null => {
  const m: Record<string, string> = {
    male: 'Male',
    female: 'Female',
    other: 'Other',
    unknown: 'Other',
  };
  return m[String(sex || '').toLowerCase()] ?? null;
};

/** Approximate age in years from an ISO date-of-birth string. */
const ageFromDob = (dob: unknown): number | null => {
  if (typeof dob !== 'string' || !dob) return null;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  const ageMsec = Date.now() - birth.getTime();
  return Math.max(1, Math.floor(ageMsec / (365.25 * 24 * 60 * 60 * 1000)));
};

// ─── Conflict audit ───────────────────────────────────────────────────────────

const writeConflictAudit = async ({
  op,
  actor,
  serverUpdatedAt,
  clientUpdatedAt,
  reason,
}: {
  op: NormalizedOp;
  actor: ScopedActor;
  serverUpdatedAt: string | null;
  clientUpdatedAt: string | null;
  reason: string;
}): Promise<void> => {
  const { error } = await supabaseAdmin.from('sync_conflict_audit').insert({
    tenant_id:           actor.tenantId,
    facility_id:         actor.facilityId,
    op_id:               op.opId,
    entity_type:         op.entityType,
    entity_id:           op.entityId,
    op_type:             op.opType,
    conflict_type:       'LWW_SERVER_WINS',
    losing_payload:      op.data,
    server_updated_at:   serverUpdatedAt,
    client_updated_at:   clientUpdatedAt,
    resolution_note:     reason,
    resolved_by_device:  null,
  });
  if (error) {
    // Non-fatal — log but don't abort the push
    console.warn('[syncApply] conflict_audit write failed:', error.message);
  }
};

// ─── patients apply ───────────────────────────────────────────────────────────

const applyPatientOp = async (
  op: NormalizedOp,
  actor: ScopedActor
): Promise<ApplyResult> => {
  const base: Omit<ApplyResult, 'status' | 'conflictReason'> = {
    opId: op.opId,
    entityType: op.entityType,
    entityId: op.entityId,
    opType: op.opType,
  };

  // ── 1. Fetch current server state ────────────────────────────────────────
  const { data: current, error: fetchErr } = await supabaseAdmin
    .from('patients')
    .select('id, row_version, updated_at, deleted_at')
    .eq('id', op.entityId)
    .eq('tenant_id', actor.tenantId)
    .eq('facility_id', actor.facilityId)
    .maybeSingle();

  if (fetchErr) throw new Error(`[syncApply] patients fetch: ${fetchErr.message}`);

  // ── 2. LWW check ─────────────────────────────────────────────────────────
  const clientUpdatedAt = typeof op.data?.updated_at === 'string' ? op.data.updated_at : null;
  const serverUpdatedAt = current ? String(current.updated_at || '') : null;

  if (current && clientUpdatedAt && serverUpdatedAt) {
    const clientMs = toMs(clientUpdatedAt);
    const serverMs = toMs(serverUpdatedAt);
    if (clientMs !== null && serverMs !== null && clientMs < serverMs) {
      await writeConflictAudit({
        op,
        actor,
        serverUpdatedAt,
        clientUpdatedAt,
        reason: `Server updated_at (${serverUpdatedAt}) is newer than client (${clientUpdatedAt})`,
      });
      return { ...base, status: 'conflict', conflictReason: 'SERVER_WINS_LWW' };
    }
  }

  const d = op.data || {};

  // ── 3a. Soft-delete ───────────────────────────────────────────────────────
  if (op.opType === 'delete') {
    const { error } = await supabaseAdmin
      .from('patients')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', op.entityId)
      .eq('tenant_id', actor.tenantId)
      .eq('facility_id', actor.facilityId)
      .is('deleted_at', null); // idempotent: skip if already deleted
    if (error) throw new Error(`[syncApply] patients delete: ${error.message}`);
    return { ...base, status: 'applied' };
  }

  // ── 3b. Upsert ────────────────────────────────────────────────────────────
  const gender = mapSexToGender(d.sex);
  const age    = ageFromDob(d.date_of_birth) ?? (current ? undefined : 1);

  const upsertRow: Record<string, unknown> = {
    id:           op.entityId,
    facility_id:  actor.facilityId,
    tenant_id:    actor.tenantId,
    full_name:    String(d.full_name || (current as any)?.full_name || 'Unknown'),
    phone:        d.phone   != null ? String(d.phone)   : null,
    date_of_birth: d.date_of_birth != null ? String(d.date_of_birth) : null,
    sex:          d.sex     != null ? String(d.sex)     : null,
    village:      d.village != null ? String(d.village) : null,
    kebele:       d.kebele  != null ? String(d.kebele)  : null,
    woreda:       d.woreda  != null ? String(d.woreda)  : null,
    language:     d.language != null ? String(d.language) : 'am',
    hew_user_id:  d.hew_user_id != null ? String(d.hew_user_id) : null,
    deleted_at:   d.deleted_at  != null ? String(d.deleted_at)  : null,
  };

  // Legacy compat: only set gender/age on insert (avoid overwriting existing values)
  if (!current) {
    if (gender) upsertRow.gender   = gender;
    if (age)    upsertRow.age      = age;
    upsertRow.created_by = actor.authUserId;
  } else {
    // On update, also keep gender in sync with sex
    if (gender) upsertRow.gender = gender;
    if (age)    upsertRow.age    = age;
  }

  const { error: upsertErr } = await supabaseAdmin
    .from('patients')
    .upsert(upsertRow, { onConflict: 'id', ignoreDuplicates: false });

  if (upsertErr) throw new Error(`[syncApply] patients upsert: ${upsertErr.message}`);
  return { ...base, status: 'applied' };
};

// ─── visits apply ─────────────────────────────────────────────────────────────

const applyVisitOp = async (
  op: NormalizedOp,
  actor: ScopedActor
): Promise<ApplyResult> => {
  const base: Omit<ApplyResult, 'status' | 'conflictReason'> = {
    opId: op.opId,
    entityType: op.entityType,
    entityId: op.entityId,
    opType: op.opType,
  };

  // ── 1. Fetch current server state ────────────────────────────────────────
  const { data: current, error: fetchErr } = await supabaseAdmin
    .from('visits')
    .select('id, row_version, updated_at, deleted_at')
    .eq('id', op.entityId)
    .eq('tenant_id', actor.tenantId)
    .eq('facility_id', actor.facilityId)
    .maybeSingle();

  if (fetchErr) throw new Error(`[syncApply] visits fetch: ${fetchErr.message}`);

  // ── 2. LWW check ─────────────────────────────────────────────────────────
  const clientUpdatedAt = typeof op.data?.updated_at === 'string' ? op.data.updated_at : null;
  const serverUpdatedAt = current ? String(current.updated_at || '') : null;

  if (current && clientUpdatedAt && serverUpdatedAt) {
    const clientMs = toMs(clientUpdatedAt);
    const serverMs = toMs(serverUpdatedAt);
    if (clientMs !== null && serverMs !== null && clientMs < serverMs) {
      await writeConflictAudit({
        op,
        actor,
        serverUpdatedAt,
        clientUpdatedAt,
        reason: `Server updated_at (${serverUpdatedAt}) is newer than client (${clientUpdatedAt})`,
      });
      return { ...base, status: 'conflict', conflictReason: 'SERVER_WINS_LWW' };
    }
  }

  const d = op.data || {};

  // ── 3a. Soft-delete ───────────────────────────────────────────────────────
  if (op.opType === 'delete') {
    const { error } = await supabaseAdmin
      .from('visits')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', op.entityId)
      .eq('tenant_id', actor.tenantId)
      .eq('facility_id', actor.facilityId)
      .is('deleted_at', null);
    if (error) throw new Error(`[syncApply] visits delete: ${error.message}`);
    return { ...base, status: 'applied' };
  }

  // ── 3b. Upsert ────────────────────────────────────────────────────────────
  const upsertRow: Record<string, unknown> = {
    id:              op.entityId,
    facility_id:     actor.facilityId,
    tenant_id:       actor.tenantId,
    patient_id:      d.patient_id  != null ? String(d.patient_id)  : undefined,
    visit_date:      d.visit_date  != null ? String(d.visit_date)  : new Date().toISOString().slice(0, 10),
    visit_type:      d.visit_type  != null ? String(d.visit_type)  : 'outpatient',
    chief_complaint: d.chief_complaint != null ? String(d.chief_complaint) : null,
    outcome:         d.outcome     != null ? String(d.outcome)     : null,
    follow_up_date:  d.follow_up_date != null ? String(d.follow_up_date) : null,
    notes:           d.notes       != null ? String(d.notes)       : null,
    deleted_at:      d.deleted_at  != null ? String(d.deleted_at)  : null,
    // JSONB clinical snapshots
    vitals_json:     d.vitals      != null ? d.vitals      : null,
    diagnoses_json:  d.diagnoses   != null ? d.diagnoses   : null,
    treatments_json: d.treatments  != null ? d.treatments  : null,
    referral_json:   d.referral    != null ? d.referral    : null,
    assessment_json: d.assessment  != null ? d.assessment  : null,
  };

  // Legacy compat: set reason + provider on insert if not already set
  if (!current) {
    upsertRow.reason     = d.chief_complaint != null ? String(d.chief_complaint) : null;
    upsertRow.provider   = actor.authUserId; // clinician user id as provider
    upsertRow.clinician_id = actor.authUserId;
    upsertRow.created_by   = actor.authUserId;
    upsertRow.fee_paid     = 0;
  } else {
    upsertRow.clinician_id = actor.authUserId;
  }

  // Remove undefined keys (Supabase rejects undefined values)
  for (const key of Object.keys(upsertRow)) {
    if (upsertRow[key] === undefined) delete upsertRow[key];
  }

  const { error: upsertErr } = await supabaseAdmin
    .from('visits')
    .upsert(upsertRow, { onConflict: 'id', ignoreDuplicates: false });

  if (upsertErr) throw new Error(`[syncApply] visits upsert: ${upsertErr.message}`);
  return { ...base, status: 'applied' };
};

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const SUPPORTED_ENTITY_TYPES = new Set(['patients', 'visits']);

/**
 * Apply a single normalised op to the appropriate domain table.
 * Returns an ApplyResult regardless of outcome (applied / conflict / skipped).
 * Throws only on unexpected DB errors.
 */
export const applyOp = async (
  op: NormalizedOp,
  actor: ScopedActor
): Promise<ApplyResult> => {
  switch (op.entityType) {
    case 'patients':
      return applyPatientOp(op, actor);
    case 'visits':
      return applyVisitOp(op, actor);
    default:
      // Unknown entity type — op is safely in sync_op_ledger for future processing
      return {
        opId: op.opId,
        entityType: op.entityType,
        entityId: op.entityId,
        opType: op.opType,
        status: 'skipped',
        conflictReason: `Unsupported entity type: ${op.entityType}`,
      };
  }
};

/**
 * Apply a batch of newly ingested ops to domain tables.
 * Runs ops sequentially within each entityType to avoid race conditions
 * when two ops in the same batch target the same row.
 */
export const applyOpsToDatabase = async (
  ops: NormalizedOp[],
  actor: ScopedActor
): Promise<ApplyResult[]> => {
  const results: ApplyResult[] = [];
  for (const op of ops) {
    try {
      const result = await applyOp(op, actor);
      results.push(result);
    } catch (err: any) {
      console.error(`[syncApply] applyOp failed for ${op.entityType}/${op.entityId}:`, err?.message);
      results.push({
        opId: op.opId,
        entityType: op.entityType,
        entityId: op.entityId,
        opType: op.opType,
        status: 'skipped',
        conflictReason: `Apply error: ${err?.message || 'unknown'}`,
      });
    }
  }
  return results;
};

export { ScopedActor, SUPPORTED_ENTITY_TYPES };
