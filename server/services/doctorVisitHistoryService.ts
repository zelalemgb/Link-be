import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { isAuditDurabilityError, recordAuditEvent } from './audit-log';

export type DoctorVisitHistoryContractErrorCode =
  | `AUTH_${string}`
  | `PERM_${string}`
  | `TENANT_${string}`
  | `VALIDATION_${string}`
  | `CONFLICT_${string}`;

export type DoctorVisitHistoryMutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: DoctorVisitHistoryContractErrorCode; message: string };

type DoctorVisitHistoryMutationFailure = {
  ok: false;
  status: number;
  code: DoctorVisitHistoryContractErrorCode;
  message: string;
};

export type DoctorVisitHistoryMutationActor = {
  authUserId?: string;
  profileId?: string;
  tenantId?: string;
  facilityId?: string;
  role?: string;
  requestId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const hpiOnsetValues = ['sudden', 'gradual', 'unknown', ''] as const;
const hpiPatternValues = ['improving', 'worsening', 'intermittent', 'stable', ''] as const;
const smokingValues = ['never', 'current', 'former', ''] as const;
const alcoholValues = ['never', 'occasional', 'regular', ''] as const;
const doctorHistoryActionValues = [
  'draft',
  'save',
  'route',
  'admit',
  'discharge',
  'complete',
  'complete_visit',
] as const;

const hpiSchema = z
  .object({
    onset: z.enum(hpiOnsetValues),
    duration: z.string().max(160),
    pattern: z.enum(hpiPatternValues),
    associatedSymptoms: z.array(z.string().trim().min(1).max(120)).max(50),
    aggravatingFactors: z.string().max(2000),
    relievingFactors: z.string().max(2000),
  })
  .strict();

const chiefComplaintSchema = z
  .object({
    id: z.string().max(64),
    complaint: z.string().max(1000),
    hpi: hpiSchema,
  })
  .strict();

const medicalHistorySchema = z
  .object({
    diabetes: z.boolean(),
    hypertension: z.boolean(),
    priorSurgery: z.boolean(),
    medications: z.string().max(2000),
    allergies: z.string().max(2000),
    smoking: z.enum(smokingValues),
    alcohol: z.enum(alcoholValues),
    familyHistory: z.string().max(2000),
  })
  .strict();

const rosSectionSchema = z
  .object({
    checked: z.boolean(),
    findings: z.string().max(2000),
  })
  .strict();

const reviewOfSystemsSchema = z
  .object({
    general: rosSectionSchema,
    respiratory: rosSectionSchema,
    cardiovascular: rosSectionSchema,
    gastrointestinal: rosSectionSchema,
    genitourinary: rosSectionSchema,
    neurological: rosSectionSchema,
    musculoskeletal: rosSectionSchema,
  })
  .strict();

const selectedPredefinedNotesSchema = z
  .object({
    diagnoses: z.array(z.string().trim().min(1).max(4000)).max(50).optional(),
  })
  .passthrough();

const emergencyExceptionSchema = z
  .object({
    applied: z.boolean(),
    reason: z.string().max(4000).optional(),
    immediateAction: z.string().max(4000).optional(),
    missingFieldRuleIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
    recordedAt: z.string().max(160).optional(),
    recordedBy: z.string().max(512).optional(),
    eligibilityBasis: z.record(z.unknown()).optional(),
  })
  .strict();

const outstandingOrderSchema = z.union([
  z.string().trim().min(1).max(4000),
  z
    .object({
      type: z.string().max(120).optional(),
      name: z.string().max(4000).optional(),
      status: z.string().max(120).optional(),
    })
    .passthrough(),
]);

export const doctorVisitHistorySaveSchema = z
  .object({
    chiefComplaints: z.array(chiefComplaintSchema).min(1).max(10),
    medicalHistory: medicalHistorySchema,
    reviewOfSystems: reviewOfSystemsSchema,
    clinicalNotes: z
      .object({
        observations: z.string().max(4000).optional(),
        diagnosis: z.string().max(4000).optional(),
        prognosis: z.string().max(4000).optional(),
        nextSteps: z.string().max(4000).optional(),
      })
      .strict()
      .optional(),
    selectedPredefinedNotes: selectedPredefinedNotesSchema.optional(),
    action: z.enum(doctorHistoryActionValues).optional(),
    pregnancyFlag: z.boolean().optional(),
    followUp: z.string().max(500).optional(),
    emergencyException: emergencyExceptionSchema.optional(),
    outstandingOrders: z.array(outstandingOrderSchema).max(100).optional(),
    returnForOutstanding: z.boolean().optional(),
  })
  .strict();

export type DoctorVisitHistorySavePayload = z.infer<typeof doctorVisitHistorySaveSchema>;

type DoctorHistoryAction = (typeof doctorHistoryActionValues)[number];
type DoctorHistoryTerminalAction = 'admit' | 'discharge' | 'complete' | 'complete_visit';
type DoctorHistoryWarningRuleId = 'SW-001' | 'SW-002' | 'SW-003' | 'SW-004' | 'SW-005';

export type DoctorVisitHistoryWarning = {
  ruleId: DoctorHistoryWarningRuleId;
  code:
    | 'WARNING_DH_SW_001_ROS_EMPTY'
    | 'WARNING_DH_SW_002_FAMILY_HISTORY_EMPTY'
    | 'WARNING_DH_SW_003_SOCIAL_HISTORY_INCOMPLETE'
    | 'WARNING_DH_SW_004_FOLLOW_UP_MISSING'
    | 'WARNING_DH_SW_005_OUTSTANDING_ORDERS';
  message: string;
  severity: 'warning';
  ackRequired: true;
  fieldKeys: string[];
  meta?: Record<string, unknown>;
};

const allowedHistoryRoles = new Set(['doctor', 'clinical_officer', 'medical_director', 'super_admin']);
const terminalHistoryActions = new Set<DoctorHistoryTerminalAction>([
  'admit',
  'discharge',
  'complete',
  'complete_visit',
]);
const pregnancyContextPattern = /(pregnan|anc|lmp|gestation)/i;
const maternalObstetricContextPattern = /\b(lmp|ga|weeks?|trimester)\b/i;
const maternalDangerSignAbsentPattern = /\b(no|denies?)\s+danger\s+signs?\b/i;
const maternalDangerSignPresentPattern =
  /\b(danger\s*signs?|vaginal bleeding|bleeding|severe headache|blurred vision|visual disturbance|convulsion|seizure|fits|reduced fetal movement|abdominal pain|epigastric pain|swelling)\b/i;
const dhHs006Message = 'Diagnosis is required before completing, discharging, or admitting this visit.';
const dhHs010Message =
  'Emergency exception is incomplete. Add reason, immediate action, and missing-field list.';
const dhSw004Message =
  'Follow-up plan is missing. Add timeframe or next-step instruction before final completion.';
const dhSw005Message =
  'There are outstanding orders. Confirm discharge with pending orders or return patient for completion.';

const normalizeRole = (role?: string | null) => (role || '').trim().toLowerCase();

const isSuperAdmin = (role?: string) => normalizeRole(role) === 'super_admin';

const error = (
  status: number,
  code: DoctorVisitHistoryContractErrorCode,
  message: string
): DoctorVisitHistoryMutationFailure => ({
  ok: false,
  status,
  code,
  message,
});

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const asPlainObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const resolveAgeYears = (ageValue: unknown, dateOfBirth?: string | null): number | null => {
  const ageFromColumn = asNumber(ageValue);
  if (ageFromColumn !== null && ageFromColumn >= 0) {
    return ageFromColumn;
  }

  const dobText = normalizeText(dateOfBirth);
  if (!dobText) return null;

  const dobMillis = Date.parse(dobText);
  if (Number.isNaN(dobMillis)) return null;

  const dob = new Date(dobMillis);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return Number.isFinite(age) && age >= 0 ? age : null;
};

const parseExistingHistoryContext = (visitNotes: string | null | undefined) => {
  const raw = normalizeText(visitNotes);
  if (!raw) {
    return {
      observations: '',
      nextSteps: '',
      followUp: '',
      diagnosis: '',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedObject = asPlainObject(parsed);
    if (!parsedObject) {
      return {
        observations: raw,
        nextSteps: '',
        followUp: '',
        diagnosis: '',
      };
    }

    const customNotes = asPlainObject(parsedObject.customNotes) || {};
    return {
      observations:
        normalizeText(customNotes.observations) ||
        normalizeText(parsedObject.observations),
      nextSteps:
        normalizeText(customNotes.nextSteps) ||
        normalizeText(parsedObject.nextSteps),
      followUp: normalizeText(parsedObject.followUp),
      diagnosis:
        normalizeText(customNotes.diagnosis) ||
        normalizeText(parsedObject.diagnosis),
    };
  } catch {
    return {
      observations: raw,
      nextSteps: '',
      followUp: '',
      diagnosis: '',
    };
  }
};

type HistoryCohort = 'adult' | 'pediatric' | 'maternal';

type HistoryCohortContext = {
  cohort: HistoryCohort;
  ageYears: number | null;
  observations: string;
  nextSteps: string;
  followUp: string;
  weight: number | null;
  bloodPressure: string;
};

const buildHistoryCohortContext = ({
  payload,
  visitRow,
  patientRow,
}: {
  payload: DoctorVisitHistorySavePayload;
  visitRow: {
    weight?: number | string | null;
    blood_pressure?: string | null;
    visit_notes?: string | null;
  };
  patientRow: {
    age?: number | string | null;
    date_of_birth?: string | null;
    gender?: string | null;
  };
}): HistoryCohortContext => {
  const existing = parseExistingHistoryContext(visitRow.visit_notes || null);
  const observations = normalizeText(payload.clinicalNotes?.observations) || existing.observations;
  const nextSteps = normalizeText(payload.clinicalNotes?.nextSteps) || existing.nextSteps;
  const followUp = normalizeText(payload.followUp) || existing.followUp;

  const chiefComplaintText = payload.chiefComplaints
    .map((complaint) => normalizeText(complaint.complaint))
    .filter(Boolean)
    .join(' ');
  const pregnancyContextText = `${chiefComplaintText} ${observations} ${nextSteps}`;

  const normalizedGender = normalizeText(patientRow.gender).toLowerCase();
  const isFemale = normalizedGender === 'female' || normalizedGender === 'f';
  const hasPregnancyContext =
    payload.pregnancyFlag === true || pregnancyContextPattern.test(pregnancyContextText);

  const ageYears = resolveAgeYears(patientRow.age, patientRow.date_of_birth || null);

  let cohort: HistoryCohort = 'adult';
  if (isFemale && hasPregnancyContext) {
    cohort = 'maternal';
  } else if (ageYears !== null && ageYears < 15) {
    cohort = 'pediatric';
  }

  return {
    cohort,
    ageYears,
    observations,
    nextSteps,
    followUp,
    weight: asNumber(visitRow.weight),
    bloodPressure: normalizeText(visitRow.blood_pressure),
  };
};

const validateCohortSpecificHistorySafetyRules = (
  context: HistoryCohortContext
): DoctorVisitHistoryMutationFailure | null => {
  if (context.cohort === 'pediatric') {
    if (!(context.weight !== null && context.weight > 0)) {
      return error(
        400,
        'VALIDATION_DH_HS_007_PEDIATRIC_WEIGHT_REQUIRED',
        'Patient weight is required for pediatric safety checks before continuing.'
      );
    }

    const followUpPresent = normalizeText(context.followUp) || normalizeText(context.nextSteps);
    if (!followUpPresent) {
      return error(
        400,
        'VALIDATION_DH_PEDIATRIC_FOLLOW_UP_REQUIRED',
        'Follow-up plan is required for pediatric safety before continuing.'
      );
    }
  }

  if (context.cohort === 'maternal') {
    if (!context.bloodPressure) {
      return error(
        400,
        'VALIDATION_DH_HS_008_MATERNAL_BP_REQUIRED',
        'Blood pressure is required for maternal safety before continuing.'
      );
    }

    if (!maternalObstetricContextPattern.test(context.observations)) {
      return error(
        400,
        'VALIDATION_DH_HS_009_MATERNAL_OBSTETRIC_CONTEXT_REQUIRED',
        'Maternal obstetric context is required in clinical observations (LMP/GA/weeks/trimester).'
      );
    }

    const dangerSignNarrative = `${context.observations} ${context.nextSteps}`.trim();
    const hasDangerSignScreen =
      maternalDangerSignAbsentPattern.test(dangerSignNarrative) ||
      maternalDangerSignPresentPattern.test(dangerSignNarrative);
    if (!hasDangerSignScreen) {
      return error(
        400,
        'VALIDATION_DH_MATERNAL_DANGER_SIGN_SCREEN_REQUIRED',
        'Maternal danger-sign screen documentation is required in observations or next steps before continuing.'
      );
    }
  }

  return null;
};

const validateMinimalHistorySafetyRules = (
  payload: DoctorVisitHistorySavePayload
): DoctorVisitHistoryMutationFailure | null => {
  const firstComplaint = payload.chiefComplaints[0];
  const chiefComplaint = normalizeText(firstComplaint?.complaint);
  const duration = normalizeText(firstComplaint?.hpi?.duration);
  const associatedSymptoms = (firstComplaint?.hpi?.associatedSymptoms || [])
    .map((symptom) => normalizeText(symptom))
    .filter(Boolean);
  const allergies = normalizeText(payload.medicalHistory.allergies);
  const medications = normalizeText(payload.medicalHistory.medications);

  if (!chiefComplaint) {
    return error(
      400,
      'VALIDATION_DH_HS_001_MISSING_CHIEF_COMPLAINT',
      'Chief complaint is required before you can continue.'
    );
  }
  if (!duration) {
    return error(
      400,
      'VALIDATION_DH_HS_002_MISSING_HPI_DURATION',
      'History duration is required before you can continue.'
    );
  }
  if (associatedSymptoms.length < 1) {
    return error(
      400,
      'VALIDATION_DH_HS_003_MISSING_ASSOCIATED_SYMPTOM',
      'At least one associated symptom is required.'
    );
  }
  if (!allergies) {
    return error(
      400,
      'VALIDATION_DH_HS_004_MISSING_ALLERGY_STATUS',
      "Allergy status is required. Enter known allergies or 'None/NKDA'."
    );
  }
  if (!medications) {
    return error(
      400,
      'VALIDATION_DH_HS_005_MISSING_MEDICATION_HISTORY',
      "Current medication history is required. Enter active medications or 'None'."
    );
  }

  return null;
};

const normalizeHistoryAction = (payload: DoctorVisitHistorySavePayload): DoctorHistoryAction => {
  const normalized = normalizeText(payload.action).toLowerCase();
  if ((doctorHistoryActionValues as readonly string[]).includes(normalized)) {
    return normalized as DoctorHistoryAction;
  }
  return 'save';
};

const isTerminalHistoryAction = (action: DoctorHistoryAction): action is DoctorHistoryTerminalAction =>
  terminalHistoryActions.has(action as DoctorHistoryTerminalAction);

const validateTerminalDiagnosisRule = ({
  action,
  payload,
  existingDiagnosis,
}: {
  action: DoctorHistoryAction;
  payload: DoctorVisitHistorySavePayload;
  existingDiagnosis: string;
}): DoctorVisitHistoryMutationFailure | null => {
  if (!isTerminalHistoryAction(action)) {
    return null;
  }

  const diagnosisText = normalizeText(payload.clinicalNotes?.diagnosis) || normalizeText(existingDiagnosis);
  const predefinedDiagnoses = (payload.selectedPredefinedNotes?.diagnoses || [])
    .map((diagnosis) => normalizeText(diagnosis))
    .filter(Boolean);
  if (!diagnosisText && predefinedDiagnoses.length < 1) {
    return error(
      400,
      'VALIDATION_DH_HS_006_DIAGNOSIS_REQUIRED_FOR_CLOSURE',
      dhHs006Message
    );
  }

  return null;
};

const validateEmergencyOverrideContract = (
  payload: DoctorVisitHistorySavePayload
): DoctorVisitHistoryMutationFailure | null => {
  const emergencyException = payload.emergencyException;
  if (!emergencyException || emergencyException.applied !== true) {
    return null;
  }

  const reason = normalizeText(emergencyException.reason);
  const immediateAction = normalizeText(emergencyException.immediateAction);
  const missingFieldRuleIds = (emergencyException.missingFieldRuleIds || [])
    .map((ruleId) => normalizeText(ruleId))
    .filter(Boolean);
  const recordedAt = normalizeText(emergencyException.recordedAt);
  const recordedAtValid = recordedAt.length > 0 && !Number.isNaN(Date.parse(recordedAt));
  const recordedBy = normalizeText(emergencyException.recordedBy);

  if (reason.length < 20 || immediateAction.length < 20 || missingFieldRuleIds.length < 1 || !recordedAtValid || !recordedBy) {
    return error(
      400,
      'VALIDATION_DH_HS_010_EMERGENCY_OVERRIDE_REQUIRED',
      dhHs010Message
    );
  }

  return null;
};

const buildDoctorHistoryWarning = ({
  ruleId,
  code,
  message,
  fieldKeys,
  meta,
}: {
  ruleId: DoctorHistoryWarningRuleId;
  code: DoctorVisitHistoryWarning['code'];
  message: string;
  fieldKeys: string[];
  meta?: Record<string, unknown>;
}): DoctorVisitHistoryWarning => ({
  ruleId,
  code,
  message,
  severity: 'warning',
  ackRequired: true,
  fieldKeys,
  ...(meta ? { meta } : {}),
});

const collectHistorySafetyWarnings = ({
  payload,
  action,
  context,
}: {
  payload: DoctorVisitHistorySavePayload;
  action: DoctorHistoryAction;
  context: HistoryCohortContext;
}):
  | { ok: true; warnings: DoctorVisitHistoryWarning[] }
  | DoctorVisitHistoryMutationFailure => {
  const warnings: DoctorVisitHistoryWarning[] = [];
  const rosSections = Object.values(payload.reviewOfSystems || {});
  const rosIsBlank = rosSections.length > 0 &&
    rosSections.every((section: any) => Boolean(section?.checked) === false && !normalizeText(section?.findings));
  if (rosIsBlank) {
    warnings.push(
      buildDoctorHistoryWarning({
        ruleId: 'SW-001',
        code: 'WARNING_DH_SW_001_ROS_EMPTY',
        message: 'Review of systems is blank. Confirm if ROS was intentionally deferred.',
        fieldKeys: ['reviewOfSystems'],
      })
    );
  }

  if (!normalizeText(payload.medicalHistory.familyHistory)) {
    warnings.push(
      buildDoctorHistoryWarning({
        ruleId: 'SW-002',
        code: 'WARNING_DH_SW_002_FAMILY_HISTORY_EMPTY',
        message: 'Family history is not documented. Continue only if unavailable.',
        fieldKeys: ['medicalHistory.familyHistory'],
      })
    );
  }

  if (!normalizeText(payload.medicalHistory.smoking) || !normalizeText(payload.medicalHistory.alcohol)) {
    warnings.push(
      buildDoctorHistoryWarning({
        ruleId: 'SW-003',
        code: 'WARNING_DH_SW_003_SOCIAL_HISTORY_INCOMPLETE',
        message: 'Social history is incomplete (smoking/alcohol). Continue only if unavailable.',
        fieldKeys: ['medicalHistory.smoking', 'medicalHistory.alcohol'],
      })
    );
  }

  const followUpPresent = normalizeText(context.followUp) || normalizeText(context.nextSteps);
  if (!followUpPresent) {
    if (isTerminalHistoryAction(action)) {
      return error(
        400,
        'VALIDATION_DH_SW_004_FOLLOW_UP_REQUIRED_FOR_COMPLETION',
        dhSw004Message
      );
    }
    warnings.push(
      buildDoctorHistoryWarning({
        ruleId: 'SW-004',
        code: 'WARNING_DH_SW_004_FOLLOW_UP_MISSING',
        message: dhSw004Message,
        fieldKeys: ['selectedFollowUp', 'customNotes.nextSteps'],
      })
    );
  }

  if (action === 'discharge') {
    const outstandingOrders = Array.isArray(payload.outstandingOrders) ? payload.outstandingOrders : [];
    if (outstandingOrders.length > 0 && payload.returnForOutstanding !== true) {
      return error(
        400,
        'VALIDATION_DH_SW_005_PENDING_ORDERS_ACK_REQUIRED',
        dhSw005Message
      );
    }

    if (outstandingOrders.length > 0) {
      warnings.push(
        buildDoctorHistoryWarning({
          ruleId: 'SW-005',
          code: 'WARNING_DH_SW_005_OUTSTANDING_ORDERS',
          message: dhSw005Message,
          fieldKeys: ['returnForOutstanding'],
          meta: { outstandingOrders },
        })
      );
    }
  }

  return {
    ok: true,
    warnings,
  };
};

const mergeDoctorHistoryIntoVisitNotes = ({
  existingVisitNotes,
  payload,
  nowIso,
}: {
  existingVisitNotes: string | null;
  payload: DoctorVisitHistorySavePayload;
  nowIso: string;
}) => {
  const fallbackNotes = normalizeText(existingVisitNotes);
  let baseNotes: Record<string, unknown> = {};

  if (fallbackNotes) {
    try {
      const parsed = JSON.parse(fallbackNotes);
      const parsedObject = asPlainObject(parsed);
      if (parsedObject) {
        baseNotes = parsedObject;
      } else {
        baseNotes = { observations: fallbackNotes };
      }
    } catch {
      baseNotes = { observations: fallbackNotes };
    }
  }

  const existingStructuredAssessment = asPlainObject(baseNotes.structuredAssessment) || {};
  const nextStructuredAssessment: Record<string, unknown> = {
    ...existingStructuredAssessment,
    chiefComplaints: payload.chiefComplaints,
    medicalHistory: payload.medicalHistory,
    reviewOfSystems: payload.reviewOfSystems,
  };
  if (typeof payload.pregnancyFlag === 'boolean') {
    nextStructuredAssessment.pregnancyFlag = payload.pregnancyFlag;
  }

  const nextNotes: Record<string, unknown> = {
    ...baseNotes,
    structuredAssessment: nextStructuredAssessment,
    timestamp: nowIso,
    historyLastSavedAt: nowIso,
  };

  if (payload.clinicalNotes) {
    const existingCustomNotes = asPlainObject(nextNotes.customNotes) || {};
    nextNotes.customNotes = {
      ...existingCustomNotes,
      ...Object.fromEntries(
        Object.entries(payload.clinicalNotes).filter(([, value]) => value !== undefined)
      ),
    };
  }

  if (payload.followUp !== undefined) {
    nextNotes.followUp = normalizeText(payload.followUp);
  }

  if (payload.selectedPredefinedNotes?.diagnoses) {
    nextNotes.predefinedNotes = {
      ...(asPlainObject(nextNotes.predefinedNotes) || {}),
      diagnoses: payload.selectedPredefinedNotes.diagnoses,
    };
  }

  if (payload.emergencyException) {
    nextNotes.emergencyException = payload.emergencyException;
  }

  if (payload.outstandingOrders !== undefined) {
    nextNotes.outstandingOrders = payload.outstandingOrders;
  }

  if (payload.returnForOutstanding !== undefined) {
    nextNotes.returnForOutstanding = payload.returnForOutstanding;
  }

  if (payload.action !== undefined) {
    nextNotes.historySaveAction = payload.action;
  }

  return JSON.stringify(nextNotes);
};

const ensureVisitHistoryAccess = (
  actor: DoctorVisitHistoryMutationActor
):
  | { ok: true; data: Required<Pick<DoctorVisitHistoryMutationActor, 'authUserId'>> & DoctorVisitHistoryMutationActor }
  | DoctorVisitHistoryMutationFailure => {
  if (!actor.authUserId) {
    return error(401, 'AUTH_MISSING_USER_CONTEXT', 'Missing authenticated user context');
  }

  const role = normalizeRole(actor.role);
  if (!allowedHistoryRoles.has(role)) {
    return error(403, 'PERM_VISIT_HISTORY_SAVE_FORBIDDEN', `Role ${role || 'unknown'} cannot save visit history`);
  }

  if (!isSuperAdmin(actor.role) && (!actor.tenantId || !actor.facilityId || !actor.profileId)) {
    return error(403, 'TENANT_MISSING_SCOPE_CONTEXT', 'Missing tenant, facility, or provider context');
  }

  return {
    ok: true,
    data: {
      ...actor,
      authUserId: actor.authUserId,
    },
  };
};

export const saveDoctorVisitHistory = async ({
  actor,
  visitId,
  payload,
}: {
  actor: DoctorVisitHistoryMutationActor;
  visitId: string;
  payload: DoctorVisitHistorySavePayload;
}): Promise<DoctorVisitHistoryMutationResult<{ success: boolean; warnings: DoctorVisitHistoryWarning[] }>> => {
  try {
    const actorResult = ensureVisitHistoryAccess(actor);
    if (actorResult.ok === false) return actorResult;
    const scopedActor = actorResult.data;
    const historyAction = normalizeHistoryAction(payload);

    const safetyFailure = validateMinimalHistorySafetyRules(payload);
    if (safetyFailure) {
      return safetyFailure;
    }

    const { data: visitRow, error: visitLookupError } = await supabaseAdmin
      .from('visits')
      .select('id, tenant_id, facility_id, assigned_doctor, patient_id, status, visit_notes, weight, blood_pressure')
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

    if (!isSuperAdmin(scopedActor.role)) {
      if (!visitRow.assigned_doctor || visitRow.assigned_doctor !== scopedActor.profileId) {
        return error(
          403,
          'PERM_VISIT_HISTORY_SAVE_FORBIDDEN',
          'Visit is not assigned to the authenticated provider'
        );
      }
    }

    const { data: patientRow, error: patientLookupError } = await supabaseAdmin
      .from('patients')
      .select('id, age, gender, date_of_birth')
      .eq('id', visitRow.patient_id)
      .maybeSingle();

    if (patientLookupError) {
      throw new Error(patientLookupError.message);
    }
    if (!patientRow) {
      return error(404, 'VALIDATION_PATIENT_NOT_FOUND', 'Patient not found');
    }

    const cohortContext = buildHistoryCohortContext({
      payload,
      visitRow,
      patientRow,
    });
    const cohortValidationFailure = validateCohortSpecificHistorySafetyRules(cohortContext);
    if (cohortValidationFailure) {
      return cohortValidationFailure;
    }

    const existingHistoryContext = parseExistingHistoryContext(visitRow.visit_notes || null);
    const terminalDiagnosisFailure = validateTerminalDiagnosisRule({
      action: historyAction,
      payload,
      existingDiagnosis: existingHistoryContext.diagnosis,
    });
    if (terminalDiagnosisFailure) {
      return terminalDiagnosisFailure;
    }

    const emergencyOverrideFailure = validateEmergencyOverrideContract(payload);
    if (emergencyOverrideFailure) {
      return emergencyOverrideFailure;
    }

    const warningResult = collectHistorySafetyWarnings({
      payload,
      action: historyAction,
      context: cohortContext,
    });
    if (warningResult.ok === false) {
      return warningResult;
    }
    const warnings = warningResult.warnings;

    const nowIso = new Date().toISOString();
    const mergedVisitNotes = mergeDoctorHistoryIntoVisitNotes({
      existingVisitNotes: visitRow.visit_notes || null,
      payload,
      nowIso,
    });

    let updateQuery = supabaseAdmin
      .from('visits')
      .update({
        visit_notes: mergedVisitNotes,
      })
      .eq('id', visitId);

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
      return error(409, 'CONFLICT_VISIT_HISTORY_NOT_APPLIED', 'Visit history save was not applied');
    }

    const resolvedTenantId = scopedActor.tenantId || visitRow.tenant_id;
    if (resolvedTenantId) {
      await recordAuditEvent(
        {
          action: 'save_doctor_visit_history',
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
            patientId: visitRow.patient_id || null,
            visitStatus: visitRow.status || null,
            chiefComplaintCount: payload.chiefComplaints.length,
            firstChiefComplaint: normalizeText(payload.chiefComplaints[0]?.complaint) || null,
            historyFieldsValidated: [
              'HS-001',
              'HS-002',
              'HS-003',
              'HS-004',
              'HS-005',
              ...(isTerminalHistoryAction(historyAction) ? ['HS-006'] : []),
              ...(cohortContext.cohort === 'pediatric' ? ['HS-007', 'PEDIATRIC_FOLLOW_UP_REQUIRED'] : []),
              ...(cohortContext.cohort === 'maternal'
                ? ['HS-008', 'HS-009', 'MATERNAL_DANGER_SIGN_SCREEN_REQUIRED']
                : []),
              ...(payload.emergencyException?.applied === true ? ['HS-010'] : []),
              ...warnings.map((warning) => warning.ruleId),
            ],
            cohort: cohortContext.cohort,
            ageYears: cohortContext.ageYears,
            pregnancyFlag: payload.pregnancyFlag ?? null,
            historyAction,
            warningCodes: warnings.map((warning) => warning.code),
            savedAt: nowIso,
          },
        },
        {
          strict: true,
          outboxEventType: 'audit.doctor_visit_history.write_failed',
          outboxAggregateType: 'visit',
          outboxAggregateId: visitId,
        }
      );
    }

    return { ok: true, data: { success: true, warnings } };
  } catch (serviceError: any) {
    console.error('saveDoctorVisitHistory service error:', serviceError?.message || serviceError);
    if (isAuditDurabilityError(serviceError)) {
      return error(500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
    }
    return error(500, 'CONFLICT_DOCTOR_HISTORY_SAVE_FAILED', 'Failed to save doctor visit history');
  }
};
