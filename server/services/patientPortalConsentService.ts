import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { isAuditDurabilityError, recordAuditEvent } from './audit-log';

export type ConsentContractErrorCode =
  | `AUTH_${string}`
  | `PERM_${string}`
  | `TENANT_${string}`
  | `VALIDATION_${string}`
  | `CONFLICT_${string}`;

export type ConsentResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: ConsentContractErrorCode; message: string };

type ConsentFailure = {
  ok: false;
  status: number;
  code: ConsentContractErrorCode;
  message: string;
};

export type ConsentActor = {
  patientAccountId?: string;
  tenantId?: string;
  role?: string;
  requestId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const CONSENT_COMPREHENSION_MIN_CHARS = 20;
// A "safe" comprehension length threshold used to trigger high-risk warnings even if min length is met.
const CONSENT_COMPREHENSION_SAFE_CHARS = 80;
const CONSENT_OVERRIDE_REASON_MIN_CHARS = 10;

const languageTagSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  // BCP-47-ish (kept permissive for now): "en", "en-US", "pt-BR", "zh-Hant"
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Invalid language tag');

const consentGrantSchema = z
  .object({
    facilityId: z.string().uuid(),
    consentType: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    comprehensionText: z.string().trim().min(CONSENT_COMPREHENSION_MIN_CHARS).max(2000),
    comprehensionLanguage: languageTagSchema,
    comprehensionRecordedAt: z
      .string()
      .datetime({ offset: true })
      .refine((value) => {
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) return false;
        // Allow small clock skew; reject far-future timestamps.
        return parsed <= Date.now() + 5 * 60 * 1000;
      }, 'comprehensionRecordedAt must be a valid ISO datetime (with offset) and not in the future'),
    uiLanguage: languageTagSchema.optional().nullable(),
    comprehensionConfirmed: z.literal(true),
    purpose: z.string().trim().max(500).optional().nullable(),
    highRiskOverride: z.boolean().optional().default(false),
    overrideReason: z.string().trim().max(500).optional().nullable(),
    metadata: z.record(z.any()).optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const warnings: string[] = [];
    if ((value.comprehensionText || '').trim().length < CONSENT_COMPREHENSION_SAFE_CHARS) {
      warnings.push('low_comprehension_length');
    }
    const uiLang = (value.uiLanguage || '').trim().toLowerCase();
    const compLang = (value.comprehensionLanguage || '').trim().toLowerCase();
    if (uiLang && compLang && uiLang !== compLang) {
      warnings.push('language_mismatch');
    }
    if (warnings.length > 0 && value.highRiskOverride !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `highRiskOverride must be true when high-risk warnings are present: ${warnings.join(', ')}`,
        path: ['highRiskOverride'],
      });
    }
    if (value.highRiskOverride === true) {
      const reason = (value.overrideReason || '').trim();
      if (reason.length < CONSENT_OVERRIDE_REASON_MIN_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `overrideReason is required (min ${CONSENT_OVERRIDE_REASON_MIN_CHARS} chars) when highRiskOverride=true`,
          path: ['overrideReason'],
        });
      }
    }
  });

const consentRevokeSchema = z
  .object({
    facilityId: z.string().uuid(),
    consentType: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/),
    acknowledged: z.literal(true),
    reason: z.string().trim().max(500).optional().nullable(),
    metadata: z.record(z.any()).optional().nullable(),
  })
  .strict();

const consentHistoryQuerySchema = z
  .object({
    facilityId: z.string().uuid().optional(),
    consentType: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9:_-]+$/)
      .optional(),
  })
  .strict();

const contractError = (
  status: number,
  code: ConsentContractErrorCode,
  message: string
): ConsentFailure => ({
  ok: false,
  status,
  code,
  message,
});

const normalizeRole = (role?: string | null) => (role || '').trim().toLowerCase();
const normalizeConsentType = (value: string) => value.trim().toLowerCase();

const computeAgeYears = (dateOfBirth?: string | null) => {
  if (!dateOfBirth) return null;
  const parsed = Date.parse(dateOfBirth);
  if (Number.isNaN(parsed)) return null;
  const dob = new Date(parsed);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return Number.isFinite(age) ? age : null;
};

const ensureConsentActorAccess = (
  actor: ConsentActor,
  action: 'grant' | 'revoke' | 'history' | 'read'
): { ok: true; data: Required<Pick<ConsentActor, 'patientAccountId' | 'tenantId' | 'role'>> & ConsentActor } | ConsentFailure => {
  if (!actor.patientAccountId) {
    return contractError(401, 'AUTH_MISSING_PATIENT_SESSION', 'Missing patient session');
  }
  if (!actor.tenantId) {
    return contractError(403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing tenant context');
  }

  const actorRole = normalizeRole(actor.role);
  if (actorRole && actorRole !== 'patient') {
    return contractError(
      403,
      `PERM_CONSENT_${action.toUpperCase()}_FORBIDDEN`,
      'Only patient sessions may manage portal consents'
    );
  }

  return {
    ok: true,
    data: {
      ...actor,
      patientAccountId: actor.patientAccountId,
      tenantId: actor.tenantId,
      role: actorRole || 'patient',
    },
  };
};

const ensureFacilityInTenant = async ({
  facilityId,
  tenantId,
}: {
  facilityId: string;
  tenantId: string;
}): Promise<ConsentResult<{ id: string }>> => {
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

const insertConsentHistory = async ({
  consentId,
  actor,
  facilityId,
  consentType,
  action,
  reason,
  metadata,
}: {
  consentId: string;
  actor: Required<Pick<ConsentActor, 'patientAccountId' | 'tenantId' | 'role'>> & ConsentActor;
  facilityId: string;
  consentType: string;
  action: 'grant' | 'revoke';
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}) => {
  const { error } = await supabaseAdmin.from('patient_portal_consent_history').insert({
    consent_id: consentId,
    patient_account_id: actor.patientAccountId,
    tenant_id: actor.tenantId,
    facility_id: facilityId,
    consent_type: consentType,
    action,
    reason: reason || null,
    metadata: metadata || null,
    actor_role: actor.role,
    request_id: actor.requestId || null,
  });
  if (error) {
    throw new Error(error.message);
  }
};

export const grantPatientPortalConsent = async ({
  actor,
  payload,
}: {
  actor: ConsentActor;
  payload: unknown;
}): Promise<ConsentResult<{ consent: { id: string; facilityId: string; consentType: string; isActive: true }; created: boolean }>> => {
  try {
    const actorResult = ensureConsentActorAccess(actor, 'grant');
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const parsed = consentGrantSchema.safeParse(payload);
    if (!parsed.success) {
      return contractError(
        400,
        'VALIDATION_INVALID_CONSENT_PAYLOAD',
        parsed.error.issues[0]?.message || 'Invalid consent grant payload'
      );
    }

    const consentType = normalizeConsentType(parsed.data.consentType);
    const facilityScope = await ensureFacilityInTenant({
      facilityId: parsed.data.facilityId,
      tenantId: scopedActor.tenantId,
    });
    if (facilityScope.ok === false) return facilityScope;

    const { data: existingConsent, error: lookupError } = await supabaseAdmin
      .from('patient_portal_consents')
      .select('id, is_active')
      .eq('patient_account_id', scopedActor.patientAccountId)
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', parsed.data.facilityId)
      .eq('consent_type', consentType)
      .maybeSingle();
    if (lookupError) {
      throw new Error(lookupError.message);
    }

    const now = new Date().toISOString();
    const metadata = (parsed.data.metadata as Record<string, unknown> | undefined) || null;
    const purpose = parsed.data.purpose || null;
    const comprehensionText = parsed.data.comprehensionText;
    const comprehensionLanguage = parsed.data.comprehensionLanguage;
    const comprehensionRecordedAt = parsed.data.comprehensionRecordedAt;
    const uiLanguage = parsed.data.uiLanguage ? parsed.data.uiLanguage.trim() : null;
    const highRiskOverride = parsed.data.highRiskOverride === true;
    const overrideReason = parsed.data.overrideReason ? parsed.data.overrideReason.trim() : null;

    const highRiskWarnings: string[] = [];
    if ((comprehensionText || '').trim().length < CONSENT_COMPREHENSION_SAFE_CHARS) {
      highRiskWarnings.push('low_comprehension_length');
    }
    if (uiLanguage && uiLanguage.trim().toLowerCase() !== comprehensionLanguage.trim().toLowerCase()) {
      highRiskWarnings.push('language_mismatch');
    }

    // Add server-derived warnings (not client-controlled): minor patient.
    const { data: patientAccountRow, error: patientAccountError } = await supabaseAdmin
      .from('patient_accounts')
      .select('id, tenant_id, date_of_birth')
      .eq('id', scopedActor.patientAccountId)
      .eq('tenant_id', scopedActor.tenantId)
      .maybeSingle();
    if (patientAccountError) {
      throw new Error(patientAccountError.message);
    }
    const ageYears = computeAgeYears(patientAccountRow?.date_of_birth || null);
    if (typeof ageYears === 'number' && ageYears >= 0 && ageYears < 18) {
      highRiskWarnings.push('patient_is_minor');
    }

    if (highRiskWarnings.length > 0 && highRiskOverride !== true) {
      return contractError(
        400,
        'VALIDATION_INVALID_CONSENT_PAYLOAD',
        `highRiskOverride must be true when high-risk warnings are present: ${highRiskWarnings.join(', ')}`
      );
    }

    let consentId = existingConsent?.id as string | undefined;
    let created = false;
    if (consentId) {
      const { data: updated, error: updateError } = await supabaseAdmin
        .from('patient_portal_consents')
        .update({
          is_active: true,
          granted_at: now,
          revoked_at: null,
          revoked_reason: null,
          metadata,
          purpose,
          updated_at: now,
        })
        .eq('id', consentId)
        .eq('patient_account_id', scopedActor.patientAccountId)
        .eq('tenant_id', scopedActor.tenantId)
        .select('id')
        .maybeSingle();
      if (updateError) {
        throw new Error(updateError.message);
      }
      if (!updated?.id) {
        return contractError(409, 'CONFLICT_CONSENT_GRANT_NOT_APPLIED', 'Consent grant was not applied');
      }
      consentId = updated.id;
    } else {
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('patient_portal_consents')
        .insert({
          patient_account_id: scopedActor.patientAccountId,
          tenant_id: scopedActor.tenantId,
          facility_id: parsed.data.facilityId,
          consent_type: consentType,
          is_active: true,
          granted_at: now,
          purpose,
          metadata,
        })
        .select('id')
        .single();
      if (insertError || !inserted) {
        throw new Error(insertError?.message || 'Failed to create consent');
      }
      consentId = inserted.id;
      created = true;
    }

    await insertConsentHistory({
      consentId,
      actor: scopedActor,
      facilityId: parsed.data.facilityId,
      consentType,
      action: 'grant',
      metadata: {
        purpose,
        comprehensionText,
        comprehensionLanguage,
        comprehensionRecordedAt,
        ...(uiLanguage ? { uiLanguage } : {}),
        comprehensionConfirmed: true,
        highRiskFlag: highRiskWarnings.length > 0,
        ...(highRiskWarnings.length > 0 ? { highRiskWarnings } : {}),
        highRiskOverride,
        overrideReason,
        ...(metadata ? { clientMetadata: metadata } : {}),
      },
    });

    await recordAuditEvent({
      action: 'grant_patient_portal_consent',
      eventType: created ? 'create' : 'update',
      entityType: 'patient_portal_consent',
      entityId: consentId,
      tenantId: scopedActor.tenantId,
      facilityId: parsed.data.facilityId,
      actorRole: scopedActor.role,
      actorUserId: scopedActor.patientAccountId,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: scopedActor.requestId || null,
      metadata: {
        consentType,
        purpose,
        comprehensionText,
        comprehensionLanguage,
        comprehensionRecordedAt,
        uiLanguage,
        comprehensionConfirmed: true,
        highRiskFlag: highRiskWarnings.length > 0,
        highRiskWarnings,
        highRiskOverride,
        overrideReason,
        created,
      },
    }, {
      strict: true,
      outboxEventType: 'audit.patient_consent.grant.write_failed',
      outboxAggregateType: 'patient_consent',
      outboxAggregateId: consentId,
    });

    return {
      ok: true,
      data: {
        consent: {
          id: consentId,
          facilityId: parsed.data.facilityId,
          consentType,
          isActive: true,
        },
        created,
      },
    };
  } catch (error: any) {
    console.error('grantPatientPortalConsent service error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return contractError(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return contractError(500, 'CONFLICT_CONSENT_GRANT_FAILED', 'Failed to grant consent');
  }
};

export const revokePatientPortalConsent = async ({
  actor,
  payload,
}: {
  actor: ConsentActor;
  payload: unknown;
}): Promise<ConsentResult<{ consent: { id: string; facilityId: string; consentType: string; isActive: false } }>> => {
  try {
    const actorResult = ensureConsentActorAccess(actor, 'revoke');
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const parsed = consentRevokeSchema.safeParse(payload);
    if (!parsed.success) {
      return contractError(
        400,
        'VALIDATION_INVALID_CONSENT_PAYLOAD',
        parsed.error.issues[0]?.message || 'Invalid consent revoke payload'
      );
    }

    const consentType = normalizeConsentType(parsed.data.consentType);
    const facilityScope = await ensureFacilityInTenant({
      facilityId: parsed.data.facilityId,
      tenantId: scopedActor.tenantId,
    });
    if (facilityScope.ok === false) return facilityScope;

    const { data: existingConsent, error: lookupError } = await supabaseAdmin
      .from('patient_portal_consents')
      .select('id, is_active')
      .eq('patient_account_id', scopedActor.patientAccountId)
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', parsed.data.facilityId)
      .eq('consent_type', consentType)
      .maybeSingle();
    if (lookupError) {
      throw new Error(lookupError.message);
    }
    if (!existingConsent || existingConsent.is_active === false) {
      return contractError(409, 'CONFLICT_CONSENT_ACCESS_REVOKED', 'Consent access is already revoked');
    }

    const now = new Date().toISOString();
    const reason = parsed.data.reason || 'Revoked by patient';
    const metadata = (parsed.data.metadata as Record<string, unknown> | undefined) || null;
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('patient_portal_consents')
      .update({
        is_active: false,
        revoked_at: now,
        revoked_reason: reason,
        updated_at: now,
      })
      .eq('id', existingConsent.id)
      .eq('patient_account_id', scopedActor.patientAccountId)
      .eq('tenant_id', scopedActor.tenantId)
      .eq('is_active', true)
      .select('id')
      .maybeSingle();
    if (updateError) {
      throw new Error(updateError.message);
    }
    if (!updated?.id) {
      return contractError(409, 'CONFLICT_CONSENT_ACCESS_REVOKED', 'Consent access is already revoked');
    }

    await insertConsentHistory({
      consentId: updated.id,
      actor: scopedActor,
      facilityId: parsed.data.facilityId,
      consentType,
      action: 'revoke',
      reason,
      metadata: {
        acknowledged: true,
        ...(metadata ? { metadata } : {}),
      },
    });

    await recordAuditEvent({
      action: 'revoke_patient_portal_consent',
      eventType: 'update',
      entityType: 'patient_portal_consent',
      entityId: updated.id,
      tenantId: scopedActor.tenantId,
      facilityId: parsed.data.facilityId,
      actorRole: scopedActor.role,
      actorUserId: scopedActor.patientAccountId,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: scopedActor.requestId || null,
      metadata: {
        consentType,
        reason,
        acknowledged: true,
      },
    }, {
      strict: true,
      outboxEventType: 'audit.patient_consent.revoke.write_failed',
      outboxAggregateType: 'patient_consent',
      outboxAggregateId: updated.id,
    });

    return {
      ok: true,
      data: {
        consent: {
          id: updated.id,
          facilityId: parsed.data.facilityId,
          consentType,
          isActive: false,
        },
      },
    };
  } catch (error: any) {
    console.error('revokePatientPortalConsent service error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return contractError(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return contractError(500, 'CONFLICT_CONSENT_REVOKE_FAILED', 'Failed to revoke consent');
  }
};

export const listPatientPortalConsentHistory = async ({
  actor,
  query,
}: {
  actor: ConsentActor;
  query: unknown;
}): Promise<
  ConsentResult<{
    history: Array<{
      id: string;
      consent_id: string;
      facility_id: string;
      consent_type: string;
      action: 'grant' | 'revoke';
      reason: string | null;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }>;
  }>
> => {
  try {
    const actorResult = ensureConsentActorAccess(actor, 'history');
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const parsed = consentHistoryQuerySchema.safeParse(query || {});
    if (!parsed.success) {
      return contractError(
        400,
        'VALIDATION_INVALID_CONSENT_HISTORY_QUERY',
        parsed.error.issues[0]?.message || 'Invalid consent history query'
      );
    }

    if (parsed.data.facilityId) {
      const facilityScope = await ensureFacilityInTenant({
        facilityId: parsed.data.facilityId,
        tenantId: scopedActor.tenantId,
      });
      if (facilityScope.ok === false) return facilityScope;
    }

    let historyQuery = supabaseAdmin
      .from('patient_portal_consent_history')
      .select('id, consent_id, facility_id, consent_type, action, reason, metadata, created_at')
      .eq('patient_account_id', scopedActor.patientAccountId)
      .eq('tenant_id', scopedActor.tenantId);

    if (parsed.data.facilityId) {
      historyQuery = historyQuery.eq('facility_id', parsed.data.facilityId);
    }
    if (parsed.data.consentType) {
      historyQuery = historyQuery.eq('consent_type', normalizeConsentType(parsed.data.consentType));
    }

    const { data, error } = await historyQuery
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) {
      throw new Error(error.message);
    }

    await recordAuditEvent({
      action: 'list_patient_portal_consent_history',
      eventType: 'read',
      entityType: 'patient_portal_consent_history',
      tenantId: scopedActor.tenantId,
      facilityId: parsed.data.facilityId || null,
      actorRole: scopedActor.role,
      actorUserId: scopedActor.patientAccountId,
      actorIpAddress: scopedActor.ipAddress || null,
      actorUserAgent: scopedActor.userAgent || null,
      complianceTags: ['hipaa'],
      sensitivityLevel: 'phi',
      requestId: scopedActor.requestId || null,
      metadata: {
        consentType: parsed.data.consentType
          ? normalizeConsentType(parsed.data.consentType)
          : null,
        resultCount: (data || []).length,
      },
    }, {
      strict: true,
      outboxEventType: 'audit.patient_consent.history.read_failed',
      outboxAggregateType: 'patient_consent',
      outboxAggregateId: scopedActor.patientAccountId,
    });

    return {
      ok: true,
      data: {
        history: ((data || []) as any[]).map((row) => ({
          id: row.id,
          consent_id: row.consent_id,
          facility_id: row.facility_id,
          consent_type: row.consent_type,
          action: row.action,
          reason: row.reason || null,
          metadata: row.metadata || null,
          created_at: row.created_at,
        })),
      },
    };
  } catch (error: any) {
    console.error('listPatientPortalConsentHistory service error:', error?.message || error);
    if (isAuditDurabilityError(error)) {
      return contractError(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return contractError(500, 'CONFLICT_CONSENT_HISTORY_READ_FAILED', 'Failed to load consent history');
  }
};

export const assertPatientPortalConsentActive = async ({
  actor,
  facilityId,
  consentType,
}: {
  actor: ConsentActor;
  facilityId: string;
  consentType: string;
}): Promise<ConsentResult<{ consentId: string }>> => {
  try {
    const actorResult = ensureConsentActorAccess(actor, 'read');
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;

    const facilityScope = await ensureFacilityInTenant({
      facilityId,
      tenantId: scopedActor.tenantId,
    });
    if (facilityScope.ok === false) return facilityScope;

    const normalizedConsentType = normalizeConsentType(consentType);
    const { data: consent, error } = await supabaseAdmin
      .from('patient_portal_consents')
      .select('id, is_active')
      .eq('patient_account_id', scopedActor.patientAccountId)
      .eq('tenant_id', scopedActor.tenantId)
      .eq('facility_id', facilityId)
      .eq('consent_type', normalizedConsentType)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }

    if (!consent || consent.is_active !== true) {
      return contractError(409, 'CONFLICT_CONSENT_ACCESS_REVOKED', 'Consent access has been revoked');
    }

    return {
      ok: true,
      data: {
        consentId: consent.id,
      },
    };
  } catch (error: any) {
    console.error('assertPatientPortalConsentActive service error:', error?.message || error);
    return contractError(500, 'CONFLICT_CONSENT_ACCESS_CHECK_FAILED', 'Failed to validate consent access');
  }
};

export const assertPatientPortalConsentActiveForProviderRead = async ({
  tenantId,
  patientAccountId,
  facilityId,
  consentType,
}: {
  tenantId: string;
  patientAccountId: string;
  facilityId: string;
  consentType: string;
}): Promise<ConsentResult<{ consentId: string }>> => {
  try {
    if (!tenantId) {
      return contractError(403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing tenant context');
    }
    if (!patientAccountId) {
      return contractError(400, 'VALIDATION_MISSING_PATIENT_ACCOUNT_ID', 'Missing patient account id');
    }

    const facilityScope = await ensureFacilityInTenant({ facilityId, tenantId });
    if (facilityScope.ok === false) return facilityScope;

    const normalizedConsentType = normalizeConsentType(consentType);
    const { data: consent, error } = await supabaseAdmin
      .from('patient_portal_consents')
      .select('id, is_active')
      .eq('patient_account_id', patientAccountId)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId)
      .eq('consent_type', normalizedConsentType)
      .maybeSingle();
    if (error) {
      throw new Error(error.message);
    }

    if (!consent) {
      return contractError(403, 'PERM_PHI_CONSENT_REQUIRED', 'Patient portal consent is required');
    }

    if (consent.is_active !== true) {
      return contractError(409, 'CONFLICT_CONSENT_ACCESS_REVOKED', 'Consent access has been revoked');
    }

    return { ok: true, data: { consentId: consent.id } };
  } catch (error: any) {
    console.error('assertPatientPortalConsentActiveForProviderRead service error:', error?.message || error);
    return contractError(500, 'CONFLICT_CONSENT_ACCESS_CHECK_FAILED', 'Failed to validate consent access');
  }
};
