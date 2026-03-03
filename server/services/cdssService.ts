import { z } from 'zod';
import ruleset from '../data/ethiopiaPhcCdssRules.json';
import { supabaseAdmin } from '../config/supabase';

type CdsCheckpoint = 'triage' | 'consult' | 'route' | 'admit' | 'discharge';
type CdsCohort = 'adult' | 'pediatric' | 'maternal';
type ReferralUrgency = 'routine' | 'urgent' | 'emergency';

type CdsIssue = {
  id: string;
  code: string;
  message: string;
  clinicalIntent?: string;
};

type CdsRecommendation = {
  text: string;
  source: string;
};

type CdsAiAdvisory = {
  enabled: boolean;
  status: 'skipped' | 'generated' | 'unavailable';
  requiresClinicianConfirmation: true;
  summary?: string;
  confidence?: 'low' | 'medium' | 'high';
  model?: string;
  error?: string;
};

type CdsBriefSummary = {
  text: string;
  guidelineBasis: string;
};

export type CdsEvaluateResult = {
  success: true;
  algorithmVersion: string;
  algorithmName: string;
  cohort: CdsCohort;
  hardStops: CdsIssue[];
  warnings: CdsIssue[];
  recommendations: CdsRecommendation[];
  referral: {
    required: boolean;
    urgency: ReferralUrgency | null;
    reasons: string[];
  };
  briefSummary: CdsBriefSummary;
  aiAdvisory: CdsAiAdvisory;
};

const bpRegex = /(\d{2,3})\s*\/\s*(\d{2,3})/;

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const normalizeSymptom = (value: string) => value.trim().toLowerCase();

const containsAny = (haystack: string[], needles: string[]) =>
  needles.some((needle) => haystack.some((item) => item.includes(needle)));

const parseBloodPressure = (value?: string | null) => {
  const raw = normalizeText(value);
  const match = raw.match(bpRegex);
  if (!match) return null;
  return {
    systolic: Number(match[1]),
    diastolic: Number(match[2]),
  };
};

const evaluateSchema = z.object({
  checkpoint: z.enum(['triage', 'consult', 'route', 'admit', 'discharge']),
  patient: z.object({
    ageYears: z.number().min(0).max(130).optional().nullable(),
    sex: z.string().optional().nullable(),
    pregnant: z.boolean().optional().nullable(),
  }).default({}),
  vitals: z.object({
    temperature: z.number().optional().nullable(),
    bloodPressure: z.string().optional().nullable(),
    heartRate: z.number().optional().nullable(),
    respiratoryRate: z.number().optional().nullable(),
    oxygenSaturation: z.number().optional().nullable(),
    weightKg: z.number().optional().nullable(),
  }).default({}),
  symptoms: z.array(z.string()).default([]),
  chiefComplaint: z.string().optional().nullable(),
  clinicalNotes: z.string().optional().nullable(),
  diagnosis: z.string().optional().nullable(),
  pendingOrders: z.array(z.string()).default([]),
  acknowledgeOutstandingOrders: z.boolean().default(false),
  includeAiAdvisory: z.boolean().default(false),
});

export type CdsEvaluateInput = z.infer<typeof evaluateSchema>;

const resolveCohort = (input: CdsEvaluateInput): CdsCohort => {
  const ageYears = input.patient.ageYears ?? null;
  const sex = normalizeText(input.patient.sex).toLowerCase();
  const symptoms = input.symptoms.map(normalizeSymptom);
  const complaint = normalizeText(input.chiefComplaint).toLowerCase();
  const notes = normalizeText(input.clinicalNotes).toLowerCase();
  const pregnancyContext = containsAny(
    [...symptoms, complaint, notes],
    ['pregnan', 'lmp', 'gestation', 'antenatal', 'anc']
  );

  if (input.patient.pregnant === true || (sex === 'female' && pregnancyContext)) {
    return 'maternal';
  }
  if (typeof ageYears === 'number' && ageYears < 15) {
    return 'pediatric';
  }
  return 'adult';
};

const pushIssue = (
  collection: CdsIssue[],
  code: string,
  fallbackId: string,
  fallbackMessage: string
) => {
  const hardRule = (ruleset.hardStopRules || []).find((rule: any) => rule.code === code);
  const warningRule = (ruleset.warningRules || []).find((rule: any) => rule.code === code);
  const rule = hardRule || warningRule;
  collection.push({
    id: rule?.id || fallbackId,
    code,
    message: rule?.message || fallbackMessage,
    clinicalIntent: rule?.clinicalIntent,
  });
};

const getRequiredVitals = (checkpoint: CdsCheckpoint): string[] =>
  ((ruleset as any).requiredVitalsByCheckpoint?.[checkpoint] || []) as string[];

const hasDangerRespRate = (ageYears: number | null, respiratoryRate: number | null | undefined) => {
  if (typeof respiratoryRate !== 'number') return false;
  if (ageYears === null) return respiratoryRate >= (ruleset as any).thresholds.pediatricDangerRespiratoryRate5to11;
  if (ageYears <= 11) return respiratoryRate >= (ruleset as any).thresholds.pediatricDangerRespiratoryRate5to11;
  return respiratoryRate >= (ruleset as any).thresholds.pediatricDangerRespiratoryRate12to14;
};

const buildBaselineRecommendations = (cohort: CdsCohort): CdsRecommendation[] => {
  const source = Array.isArray((ruleset as any).sources) ? (ruleset as any).sources[0] : 'Local guideline';
  const items: string[] = ((ruleset as any).baselineRecommendations?.[cohort] || []) as string[];
  return items.map((text) => ({ text, source }));
};

const checkpointLabel = (checkpoint: CdsCheckpoint) => {
  if (checkpoint === 'triage') return 'Triage';
  if (checkpoint === 'consult') return 'Consult';
  if (checkpoint === 'route') return 'Route';
  if (checkpoint === 'admit') return 'Admit';
  return 'Discharge';
};

const resolveGuidelineBasis = () => {
  const sources = Array.isArray((ruleset as any).sources)
    ? ((ruleset as any).sources as string[]).filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
  const primary =
    sources.find((item) => item.toLowerCase().includes('ethiopian')) ||
    'Ethiopian Primary Health Care Clinical Guideline';
  const secondary =
    sources.find(
      (item) =>
        item !== primary &&
        (item.toLowerCase().includes('who') ||
          item.toLowerCase().includes('general medicine') ||
          item.toLowerCase().includes('internal medicine') ||
          item.toLowerCase().includes('emergency'))
    ) || 'WHO/general medicine red-flag guidance';
  return `Primary: ${primary}. Secondary: ${secondary}.`;
};

const buildBriefSummary = ({
  checkpoint,
  cohort,
  hardStops,
  warnings,
  referralRequired,
  topRecommendation,
}: {
  checkpoint: CdsCheckpoint;
  cohort: CdsCohort;
  hardStops: CdsIssue[];
  warnings: CdsIssue[];
  referralRequired: boolean;
  topRecommendation?: CdsRecommendation;
}): CdsBriefSummary => {
  const cohortText = cohort === 'maternal' ? 'maternal' : cohort === 'pediatric' ? 'pediatric' : 'adult';
  let text = '';

  if (hardStops.length > 0) {
    text = `${checkpointLabel(checkpoint)}: ${cohortText} case has ${hardStops.length} high-risk trigger(s). ${hardStops[0].message}`;
    if (referralRequired) {
      text += ' Immediate referral/escalation is required.';
    }
  } else if (warnings.length > 0) {
    text = `${checkpointLabel(checkpoint)}: no hard-stop trigger detected. ${warnings[0].message}`;
  } else {
    text = `${checkpointLabel(checkpoint)}: no hard-stop trigger from captured data. Continue standard ${cohortText} PHC pathway and monitor response.`;
  }

  if (topRecommendation?.text) {
    text += ` ${topRecommendation.text}`;
  }

  return {
    text,
    guidelineBasis: resolveGuidelineBasis(),
  };
};

const maybeBuildAiAdvisory = async (
  input: CdsEvaluateInput,
  cohort: CdsCohort
): Promise<CdsAiAdvisory> => {
  const featureEnabled = process.env.CDSS_AI_ADVISORY_ENABLED === 'true';
  if (!input.includeAiAdvisory || !featureEnabled) {
    return {
      enabled: false,
      status: 'skipped',
      requiresClinicianConfirmation: true,
    };
  }

  try {
    const { data, error } = await supabaseAdmin.functions.invoke('ai-clinical-assistant', {
      body: {
        patientData: {
          age: input.patient.ageYears || 0,
          gender: input.patient.sex || '',
          chiefComplaint: input.chiefComplaint || input.symptoms[0] || 'Not specified',
          vitals: {
            temperature: input.vitals.temperature || undefined,
            bloodPressure: input.vitals.bloodPressure || undefined,
            heartRate: input.vitals.heartRate || undefined,
            respiratoryRate: input.vitals.respiratoryRate || undefined,
            oxygenSaturation: input.vitals.oxygenSaturation || undefined,
            weight: input.vitals.weightKg || undefined,
          },
          observations: input.clinicalNotes || input.symptoms.join(', ') || 'Not documented',
          medicalHistory: `${cohort} assessment`,
        },
      },
    });

    if (error || !data?.success) {
      return {
        enabled: true,
        status: 'unavailable',
        requiresClinicianConfirmation: true,
        error: error?.message || data?.error || 'AI advisory unavailable',
      };
    }

    const topDx = data?.analysis?.differentialDiagnosis?.[0]?.diagnosis;
    const summary =
      typeof topDx === 'string' && topDx.trim().length > 0
        ? `Top AI suggestion: ${topDx}. Requires clinician confirmation.`
        : 'AI advisory generated. Requires clinician confirmation.';

    return {
      enabled: true,
      status: 'generated',
      requiresClinicianConfirmation: true,
      summary,
      confidence: 'medium',
      model: 'ai-clinical-assistant',
    };
  } catch (error: any) {
    return {
      enabled: true,
      status: 'unavailable',
      requiresClinicianConfirmation: true,
      error: error?.message || 'AI advisory unavailable',
    };
  }
};

export const cdssEvaluateRequestSchema = evaluateSchema;

export const evaluateCdss = async (inputRaw: unknown): Promise<CdsEvaluateResult> => {
  const input = evaluateSchema.parse(inputRaw);
  const checkpoint = input.checkpoint as CdsCheckpoint;
  const cohort = resolveCohort(input);

  const hardStops: CdsIssue[] = [];
  const warnings: CdsIssue[] = [];
  const recommendations = buildBaselineRecommendations(cohort);

  const symptomsNormalized = input.symptoms.map(normalizeSymptom);
  const notesLower = normalizeText(input.clinicalNotes).toLowerCase();
  const complaintLower = normalizeText(input.chiefComplaint).toLowerCase();
  const mergedSymptomContext = [...symptomsNormalized, notesLower, complaintLower];
  const ageYears = input.patient.ageYears ?? null;

  // Hard-stop 1: critical oxygen saturation.
  if (
    typeof input.vitals.oxygenSaturation === 'number' &&
    input.vitals.oxygenSaturation <= (ruleset as any).thresholds.oxygenSaturationCritical
  ) {
    pushIssue(
      hardStops,
      'CDSS_HARD_OXYGEN_SAT_CRITICAL',
      'CDSS-HS-001',
      'Critical hypoxia detected (SpO2 <= 90%). Urgent escalation/referral is required.'
    );
  }

  // Hard-stop 2: fever + neck stiffness.
  if (
    typeof input.vitals.temperature === 'number' &&
    input.vitals.temperature >= (ruleset as any).thresholds.feverWithNeckStiffnessTemp &&
    containsAny(mergedSymptomContext, ['neck stiffness', 'stiff neck', 'mening'])
  ) {
    pushIssue(
      hardStops,
      'CDSS_HARD_FEVER_NECK_STIFFNESS',
      'CDSS-HS-002',
      'Fever with neck stiffness suggests possible severe CNS infection. Urgent referral is required.'
    );
  }

  const bp = parseBloodPressure(input.vitals.bloodPressure || null);

  if (cohort === 'maternal') {
    const maternalDangerSymptoms = containsAny(mergedSymptomContext, [
      'severe headache',
      'headache',
      'vision',
      'epigastric',
      'right upper quadrant',
      'convulsion',
    ]);
    if (
      bp &&
      (bp.systolic >= (ruleset as any).thresholds.maternalSevereBpSystolic ||
        bp.diastolic >= (ruleset as any).thresholds.maternalSevereBpDiastolic) &&
      maternalDangerSymptoms
    ) {
      pushIssue(
        hardStops,
        'CDSS_HARD_MATERNAL_SEVERE_HYPERTENSION',
        'CDSS-HS-003',
        'Maternal severe hypertension with danger symptoms detected. Emergency referral is required.'
      );
    }

    if (containsAny(mergedSymptomContext, ['bleeding', 'vaginal bleeding', 'antepartum hemorrhage'])) {
      pushIssue(
        hardStops,
        'CDSS_HARD_MATERNAL_BLEEDING',
        'CDSS-HS-004',
        'Pregnancy-related bleeding is a maternal emergency red flag. Urgent referral is required.'
      );
    }
  }

  if (cohort === 'pediatric') {
    const pediatricDangerSigns = containsAny(mergedSymptomContext, [
      'unable to drink',
      'convulsion',
      'letharg',
      'chest indrawing',
      'stridor',
      'cyanosis',
    ]);
    const rapidResp = hasDangerRespRate(ageYears, input.vitals.respiratoryRate);
    if (pediatricDangerSigns || rapidResp) {
      pushIssue(
        hardStops,
        'CDSS_HARD_PEDIATRIC_RESP_DISTRESS',
        'CDSS-HS-005',
        'Pediatric respiratory danger signs detected. Urgent referral is required.'
      );
    }

    if (
      (checkpoint === 'route' || checkpoint === 'admit' || checkpoint === 'discharge') &&
      !(typeof input.vitals.weightKg === 'number' && input.vitals.weightKg > 0)
    ) {
      pushIssue(
        hardStops,
        'CDSS_HARD_PEDIATRIC_WEIGHT_REQUIRED',
        'CDSS-HS-006',
        'Pediatric weight is required before final treatment/disposition decisions.'
      );
    }
  }

  if (
    (checkpoint === 'admit' || checkpoint === 'discharge') &&
    normalizeText(input.diagnosis).length === 0
  ) {
    pushIssue(
      hardStops,
      'CDSS_HARD_DIAGNOSIS_REQUIRED_FOR_CLOSURE',
      'CDSS-HS-007',
      'Diagnosis is required before admit/discharge decisions.'
    );
  }

  if (checkpoint === 'discharge' && input.pendingOrders.length > 0) {
    if (!input.acknowledgeOutstandingOrders) {
      pushIssue(
        hardStops,
        'CDSS_HARD_PENDING_ORDERS_ACK_REQUIRED',
        'CDSS-HS-008',
        'Outstanding orders exist. Confirm acknowledgment before discharge.'
      );
    } else {
      pushIssue(
        warnings,
        'CDSS_WARN_PENDING_ORDERS_ACKNOWLEDGED',
        'CDSS-SW-002',
        'Discharge with pending orders acknowledged. Ensure patient follow-up instructions are clear.'
      );
    }
  }

  const requiredVitals = getRequiredVitals(checkpoint);
  const missingVitals = requiredVitals.filter((field) => {
    if (field === 'bloodPressure') return normalizeText(input.vitals.bloodPressure).length === 0;
    const value = (input.vitals as any)[field];
    return typeof value !== 'number' || Number.isNaN(value);
  });

  if (missingVitals.length > 0) {
    pushIssue(
      warnings,
      'CDSS_WARN_MISSING_REQUIRED_VITALS',
      'CDSS-SW-001',
      `Missing required vitals: ${missingVitals.join(', ')}.`
    );
  }

  const referralReasons = hardStops.map((item) => item.message);
  const hasEmergency = hardStops.some((item) =>
    ['CDSS_HARD_OXYGEN_SAT_CRITICAL', 'CDSS_HARD_MATERNAL_SEVERE_HYPERTENSION'].includes(item.code)
  );

  const aiAdvisory = await maybeBuildAiAdvisory(input, cohort);
  const referralRequired = hardStops.length > 0;
  const briefSummary = buildBriefSummary({
    checkpoint,
    cohort,
    hardStops,
    warnings,
    referralRequired,
    topRecommendation: recommendations[0],
  });

  return {
    success: true,
    algorithmVersion: (ruleset as any).version || 'unknown',
    algorithmName: (ruleset as any).name || 'CDSS',
    cohort,
    hardStops,
    warnings,
    recommendations,
    referral: {
      required: referralRequired,
      urgency: hardStops.length === 0 ? null : hasEmergency ? 'emergency' : 'urgent',
      reasons: referralReasons,
    },
    briefSummary,
    aiAdvisory,
  };
};
