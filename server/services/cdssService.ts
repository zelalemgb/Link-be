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
  consultationPhase: 'emergency' | 'diagnostic' | 'awaiting_results' | 'interpret_results' | 'treatment';
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
  labResults: z.array(z.object({
    name: z.string(),
    value: z.string(),
    referenceRange: z.string().optional().nullable(),
  })).default([]),
  imagingResults: z.array(z.object({
    study: z.string(),
    findings: z.string(),
  })).default([]),
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

// ─────────────────────────────────────────────────────────────────────────────
// FOCUSED NEXT-STEP ENGINE
//
// Instead of running every condition check in parallel and returning whatever
// happened to fire first, this function maps the current consultation STATE to
// the SINGLE most important action the doctor should take right now.
//
// Logic runs as a priority ladder:
//   1. Emergency / danger signs  → handled upstream by hard-stops (not here)
//   2. Results are back          → handled by result-interpretation recs (not here)
//   3. Working diagnosis set     → recommend the specific treatment protocol
//   4. Tests ordered, pending    → acknowledge; nothing new to recommend yet
//   5. No workup started yet     → recommend the ONE key diagnostic test for
//                                  this chief complaint cluster
// ─────────────────────────────────────────────────────────────────────────────
const buildFocusedNextStep = (
  input: CdsEvaluateInput,
  mergedContext: string[],
  cohort: CdsCohort,
): CdsRecommendation | null => {
  const ctx = mergedContext;

  // Has a specific test been ordered or resulted already?
  const testOrdered = (partial: string) =>
    input.pendingOrders.some(o => o.toLowerCase().includes(partial));
  const testResulted = (partial: string) =>
    input.labResults.some(r => r.name.toLowerCase().includes(partial)) ||
    input.imagingResults.some(r => r.study.toLowerCase().includes(partial));
  const testDone = (partial: string) => testOrdered(partial) || testResulted(partial);

  const hasDiagnosis = normalizeText(input.diagnosis).length > 0;

  // If results are back or a diagnosis is set we want the result-interpretation
  // recs (higher priority) to lead. Return null so the pipeline uses them.
  if (input.labResults.length > 0 || input.imagingResults.length > 0) return null;

  // ── FEVER / FEBRILE ILLNESS ──────────────────────────────────────────────
  // Malaria is the most common cause of fever in Ethiopia — confirm before
  // anything else. Do not simultaneously suggest TB screening, anaemia workup, etc.
  if (containsAny(ctx, ['fever', 'febrile', 'high temperature', 'high grade fever',
      'chills', 'rigors', 'hot body', 'feeling hot', 'pyrexia'])) {
    if (!testDone('malaria') && !testDone('rdt') && !testDone('rapid')) {
      return {
        text: 'Order Malaria RDT — first-line test for any febrile illness. Do not treat empirically before confirming.',
        source: 'Ethiopian Malaria Elimination Guidelines / IMNCI',
      };
    }
    if (testOrdered('malaria') || testOrdered('rdt')) {
      // Ordered but result not back yet — nothing new to recommend
      return {
        text: 'Malaria RDT ordered — await result before initiating treatment. Monitor vital signs and danger signs.',
        source: 'Ethiopian Malaria Elimination Guidelines',
      };
    }
    // Result is back (handled by result-interpretation recs above via null return)
    return null;
  }

  // ── COUGH ────────────────────────────────────────────────────────────────
  if (containsAny(ctx, ['cough', 'productive cough', 'dry cough', 'wet cough',
      'coughing up', 'chronic cough', 'haemoptysis', 'hemoptysis'])) {
    const hasProlonged = containsAny(ctx, ['2 week', '>2 week', 'two week', 'chronic',
        'months', 'persistent cough', 'prolonged cough', 'cough for weeks', 'weeks of cough']);
    const hasTBSigns  = containsAny(ctx, ['night sweat', 'weight loss', 'wasting',
        'drenching sweat', 'haemoptysis', 'hemoptysis', 'blood in sputum']);
    const hasRespDistress = containsAny(ctx, ['fast breathing', 'tachypnoea', 'chest indrawing',
        'shortness of breath', 'difficulty breathing', 'unable to breathe', 'grunting', 'stridor']);

    // TB screening takes priority over general chest workup
    if (hasProlonged && hasTBSigns) {
      if (!testDone('sputum') && !testDone('xpert') && !testDone('afb') && !testDone('mtb')) {
        return {
          text: 'Order Sputum Xpert MTB/RIF — cough ≥2 weeks with systemic symptoms meets TB screening criteria. Apply infection control: mask patient, separate waiting area.',
          source: 'Ethiopian National TB/HIV Guidelines (2022)',
        };
      }
      if (testOrdered('sputum') || testOrdered('xpert')) {
        return {
          text: 'Sputum Xpert ordered — await result. Continue infection control precautions. HIV test if status unknown.',
          source: 'Ethiopian National TB Guidelines (2022)',
        };
      }
      return null;
    }

    // Acute cough with respiratory distress → CXR
    if (hasRespDistress && !testDone('chest') && !testDone('cxr')) {
      return {
        text: 'Order Chest X-ray — respiratory distress with cough requires imaging to classify pneumonia severity and guide treatment.',
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)',
      };
    }

    // Simple acute cough, no red flags, no prior workup → classify by IMNCI
    if (!hasDiagnosis && !hasRespDistress && !testDone('chest')) {
      return {
        text: 'Classify cough severity using IMNCI: count respiratory rate (fast breathing?), assess chest indrawing, SpO2. Order CXR if any of these are present.',
        source: 'Ethiopian IMNCI',
      };
    }
    return null;
  }

  // ── DIARRHOEA ────────────────────────────────────────────────────────────
  if (containsAny(ctx, ['diarrhoea', 'diarrhea', 'loose stool', 'watery stool',
      'frequent stool', 'loose motions', 'acute gastroenteritis'])) {
    const hasSevereDehydration = containsAny(ctx, ['unable to drink', 'sunken eyes severe',
        'very slow skin pinch', 'lethargic', 'unconscious', 'absent radial pulse']);
    const hasBloodyStool = containsAny(ctx, ['bloody stool', 'blood in stool', 'dysentery',
        'mucus stool', 'frank blood']);

    if (hasSevereDehydration) {
      return {
        text: 'Severe dehydration — start IV Ringer\'s Lactate 100mL/kg immediately (Plan C). Refer if IV access not available.',
        source: 'WHO / Ethiopian IMNCI Guideline',
      };
    }
    if (hasBloodyStool && !testDone('stool') && !hasDiagnosis) {
      return {
        text: 'Order Stool R/E (routine and examination) — bloody diarrhoea requires microscopy to differentiate dysentery (shigella/amoeba) from other causes before antibiotic selection.',
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)',
      };
    }
    if (!hasDiagnosis) {
      return {
        text: 'Assess dehydration status (Plan A/B/C). Prescribe ORS if any dehydration. Add zinc 20mg/day × 10 days. Antibiotics only for bloody stool or confirmed cholera.',
        source: 'WHO / Ethiopian IMNCI Guideline',
      };
    }
    return null;
  }

  // ── URINARY SYMPTOMS ─────────────────────────────────────────────────────
  if (containsAny(ctx, ['dysuria', 'burning urine', 'burning micturition', 'urinary frequency',
      'urinary urgency', 'flank pain', 'loin pain', 'suprapubic pain'])) {
    if (!testDone('urine') && !testDone('urinalysis') && !testDone('dipstick')) {
      return {
        text: 'Order Urine Dipstick (nitrites + leucocytes) — confirms UTI diagnosis and guides antibiotic selection. Send urine C&S if recurrent.',
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)',
      };
    }
    if (testOrdered('urine') || testOrdered('urinalysis')) {
      return {
        text: 'Urine dipstick ordered — await result. Ensure adequate fluid intake. Avoid empirical antibiotics until result available.',
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)',
      };
    }
    return null;
  }

  // ── HEADACHE / HYPERTENSION ──────────────────────────────────────────────
  if (containsAny(ctx, ['headache', 'head pain', 'severe headache', 'dizziness',
      'hypertension', 'high blood pressure', 'blurred vision'])) {
    const bp = parseBloodPressure(input.vitals.bloodPressure || null);
    if (!bp) {
      return {
        text: 'Measure blood pressure — hypertension must be excluded in any patient with headache or dizziness before other workup.',
        source: 'Ethiopian NCD Guideline',
      };
    }
    // BP is recorded — the condition-specific BP checks (hard-stops/warnings) handle the rest
    return null;
  }

  // ── POLYURIA / DIABETES SCREENING ───────────────────────────────────────
  if (containsAny(ctx, ['polyuria', 'polydipsia', 'excessive thirst', 'frequent urination',
      'diabetes', 'high blood sugar', 'unexplained weight loss'])) {
    if (!testDone('glucose') && !testDone('rbs') && !testDone('fbs') && !testDone('blood sugar')
        && !testDone('hba1c')) {
      return {
        text: 'Order Random Blood Sugar (RBS) — polyuria and polydipsia require diabetes confirmation before any treatment is initiated.',
        source: 'Ethiopian NCD Guideline',
      };
    }
    if (testOrdered('glucose') || testOrdered('rbs') || testOrdered('fbs')) {
      return {
        text: 'Blood sugar test ordered — await result. Advise water intake. Do not initiate glucose-lowering therapy before confirming diagnosis.',
        source: 'Ethiopian NCD Guideline',
      };
    }
    return null;
  }

  // ── CHEST PAIN ───────────────────────────────────────────────────────────
  if (containsAny(ctx, ['chest pain', 'central chest pain', 'retrosternal pain',
      'chest tightness', 'crushing chest', 'radiating arm pain', 'jaw pain cardiac'])) {
    if (!testDone('ecg') && !testDone('electrocardiogram') && !testDone('ekg')) {
      return {
        text: 'Order ECG immediately — chest pain requires ECG to exclude STEMI and life-threatening arrhythmia before other workup.',
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)',
      };
    }
    return null;
  }

  // ── JAUNDICE ─────────────────────────────────────────────────────────────
  if (containsAny(ctx, ['jaundice', 'yellow eyes', 'yellow skin', 'icteric',
      'scleral icterus', 'yellowish'])) {
    if (!testDone('lft') && !testDone('liver function') && !testDone('bilirubin')
        && !testDone('hepatitis')) {
      return {
        text: 'Order LFT (bilirubin, ALT, AST, ALP) and Hepatitis B surface antigen — jaundice requires hepatic cause confirmation before treatment.',
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)',
      };
    }
    return null;
  }

  // ── ABDOMINAL PAIN ───────────────────────────────────────────────────────
  if (containsAny(ctx, ['abdominal pain', 'stomach pain', 'belly pain', 'epigastric pain',
      'right upper quadrant', 'right iliac fossa', 'periumbilical pain', 'lower abdominal'])) {
    const hasSurgicalSigns = containsAny(ctx, ['guarding', 'rigidity', 'rebound tenderness',
        'board-like abdomen', 'acute abdomen']);
    if (hasSurgicalSigns) {
      return {
        text: 'Surgical emergency signs present — order Abdominal Ultrasound + FBC urgently and arrange surgical referral. Do not give opioids before surgical assessment.',
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)',
      };
    }
    if (!testDone('abdomen') && !testDone('ultrasound') && !testDone('abdominal us')) {
      return {
        text: 'Order Abdominal Ultrasound — localised or unexplained abdominal pain requires imaging to exclude surgical causes (appendicitis, cholecystitis, obstruction).',
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)',
      };
    }
    return null;
  }

  // ── MATERNAL / ANC ───────────────────────────────────────────────────────
  if (cohort === 'maternal') {
    const hivTested = containsAny(ctx, ['hiv test', 'hiv result', 'hiv positive',
        'hiv negative', 'pmtct', 'art in pregnancy']);
    if (!hivTested && !testDone('hiv')) {
      return {
        text: 'Offer HIV rapid test — mandatory at first ANC visit per PMTCT Option B+ protocol. Also test for syphilis (RPR/VDRL).',
        source: 'Ethiopian PMTCT Programme Guidelines (2021)',
      };
    }
    const bpChecked = parseBloodPressure(input.vitals.bloodPressure || null);
    if (!bpChecked) {
      return {
        text: 'Measure blood pressure — mandatory at every ANC visit to screen for pre-eclampsia.',
        source: 'Ethiopian ANC Guideline / RMNCH',
      };
    }
    return null;
  }

  return null; // No focused step identified — fall through to condition-specific recs
};

export const evaluateCdss = async (inputRaw: unknown): Promise<CdsEvaluateResult> => {
  const input = evaluateSchema.parse(inputRaw);
  const checkpoint = input.checkpoint as CdsCheckpoint;
  const cohort = resolveCohort(input);

  const hardStops: CdsIssue[] = [];
  const warnings: CdsIssue[] = [];
  // Baseline recs are generic boilerplate — held separately so condition-specific
  // and result-confirmed recs always take priority in the final output.
  const baselineRecs = buildBaselineRecommendations(cohort);
  const recommendations: CdsRecommendation[] = [];

  const symptomsNormalized = input.symptoms.map(normalizeSymptom);
  const notesLower = normalizeText(input.clinicalNotes).toLowerCase();
  const complaintLower = normalizeText(input.chiefComplaint).toLowerCase();
  const mergedSymptomContext = [...symptomsNormalized, notesLower, complaintLower];
  const ageYears = input.patient.ageYears ?? null;

  // Inject lab results and imaging findings so all existing containsAny rules
  // automatically benefit from actual result values (e.g. "rdt positive" → treatment path).
  if (input.labResults.length > 0) {
    mergedSymptomContext.push(
      input.labResults.map(r => `${r.name} ${r.value}`).join(' ').toLowerCase()
    );
  }
  if (input.imagingResults.length > 0) {
    mergedSymptomContext.push(
      input.imagingResults.map(r => `${r.study} ${r.findings}`).join(' ').toLowerCase()
    );
  }
  // Set of result names already available — used to suppress redundant "order X" guidance
  const resultNames = new Set<string>([
    ...input.labResults.map(r => r.name.toLowerCase()),
    ...input.imagingResults.map(r => r.study.toLowerCase()),
  ]);

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

  // Hard-stop 2: fever + neck stiffness (meningitis).
  if (
    typeof input.vitals.temperature === 'number' &&
    input.vitals.temperature >= (ruleset as any).thresholds.feverWithNeckStiffnessTemp &&
    containsAny(mergedSymptomContext, ['neck stiffness', 'stiff neck', 'mening', 'photophobia', 'kernig', 'brudzinski'])
  ) {
    pushIssue(
      hardStops,
      'CDSS_HARD_FEVER_NECK_STIFFNESS',
      'CDSS-HS-002',
      'Fever with neck stiffness — bacterial meningitis until proven otherwise. Give ceftriaxone pre-referral. Emergency transfer.'
    );
  }

  // Warning: borderline SpO2
  if (
    typeof input.vitals.oxygenSaturation === 'number' &&
    input.vitals.oxygenSaturation > (ruleset as any).thresholds.oxygenSaturationCritical &&
    input.vitals.oxygenSaturation <= (ruleset as any).thresholds.oxygenSaturationWarning
  ) {
    pushIssue(warnings, 'CDSS_WARN_OXY_SAT_BORDERLINE', 'CDSS-SW-021', 'Borderline SpO2 (91–94%). Monitor and provide supplemental oxygen if symptomatic.');
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

  // ── MALARIA ──────────────────────────────────────────────────────────────
  const isMalariaPositive = containsAny(mergedSymptomContext, [
    'malaria positive', 'rdt positive', 'malaria rdt +', 'positive rdt', 'plasmodium',
    'p. falciparum', 'p. vivax', 'malaria confirmed',
  ]);
  const isMalariaSuspect = containsAny(mergedSymptomContext, ['malaria', 'fever and chills', 'febrile illness', 'suspected malaria']);
  const hasSevereMalariaSign = containsAny(mergedSymptomContext, [
    'convulsion', 'unconscious', 'altered consciousness', 'vomiting everything',
    'unable to drink', 'prostration', 'jaundice', 'dark urine', 'abnormal bleeding malaria',
  ]);

  if ((isMalariaPositive || isMalariaSuspect) && hasSevereMalariaSign) {
    pushIssue(hardStops, 'CDSS_HARD_SEVERE_MALARIA', 'CDSS-HS-009', 'Severe malaria danger signs. IV artesunate first-line. Give rectal artesunate pre-referral if IV unavailable. Emergency transfer.');
  } else if (isMalariaPositive && !hasSevereMalariaSign) {
    pushIssue(warnings, 'CDSS_WARN_MALARIA_RDT_POSITIVE', 'CDSS-SW-003', 'Positive malaria test. Prescribe first-line ACT (AL) per weight/age chart. Counsel on completing full 3-day course.');
    recommendations.push({ text: 'Prescribe Artemether-Lumefantrine (AL) weight-based: 5–14kg = 1 tab, 15–24kg = 2 tabs, 25–34kg = 3 tabs, >34kg = 4 tabs twice daily × 3 days. Counsel on return if danger signs.', source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)' });
  } else if (isMalariaSuspect && !isMalariaPositive) {
    pushIssue(warnings, 'CDSS_WARN_MALARIA_SUSPECT_NO_RDT', 'CDSS-SW-024', 'Febrile illness without confirmed RDT/microscopy. Do not treat empirically — confirm diagnosis first per malaria elimination guidelines.');
  }

  if ((isMalariaPositive || isMalariaSuspect) && cohort === 'maternal') {
    pushIssue(warnings, 'CDSS_WARN_MALARIA_IN_PREGNANCY', 'CDSS-SW-004', 'Malaria in pregnancy: AL from 2nd trimester; quinine + clindamycin in 1st trimester. Confirm gestational age before prescribing.');
  }

  // ── TUBERCULOSIS ─────────────────────────────────────────────────────────
  if (containsAny(mergedSymptomContext, ['haemoptysis', 'hemoptysis', 'blood in sputum', 'coughing up blood'])) {
    pushIssue(hardStops, 'CDSS_HARD_HEMOPTYSIS_TB', 'CDSS-HS-010', 'Haemoptysis. Apply infection control. Urgent evaluation for TB. Refer to hospital with Xpert and CXR capability.');
  }

  const hasTBSystemicSymptoms = containsAny(mergedSymptomContext, ['night sweats', 'weight loss', 'loss of weight', 'wasting', 'drenching sweat']);
  const hasProlongedCough = containsAny(mergedSymptomContext, [
    'cough 2 weeks', 'cough for 2', 'cough >2', 'chronic cough', 'prolonged cough',
    'weeks of cough', 'persistent cough', 'cough for weeks', 'cough months',
  ]);
  const hasTBContact = containsAny(mergedSymptomContext, ['tb contact', 'tuberculosis contact', 'household tb', 'known tb contact', 'family member tb']);

  if (!hardStops.find((h) => h.code === 'CDSS_HARD_HEMOPTYSIS_TB')) {
    if (hasProlongedCough && hasTBSystemicSymptoms) {
      pushIssue(warnings, 'CDSS_WARN_TB_SCREENING_INDICATED', 'CDSS-SW-005', 'TB screening indicated. Request Xpert MTB/RIF. Apply infection control: mask patient, separate waiting area.');
      recommendations.push({ text: 'Sputum Xpert MTB/RIF and CXR. Mask patient in a separate ventilated area. Trace and register household contacts. HIV test if status unknown.', source: 'Ethiopian National TB/HIV Guidelines (2022)' });
    }
  }

  if (hasTBContact) {
    pushIssue(warnings, 'CDSS_WARN_TB_CONTACT', 'CDSS-SW-006', 'Known TB contact. Screen for active TB. Assess IPT eligibility (HIV-positive contacts; children <5 in household).');
    recommendations.push({ text: 'Screen with Xpert MTB/RIF. If active TB excluded and eligible: give isoniazid 5mg/kg/day (max 300mg) × 6 months as IPT with pyridoxine 25mg/day.', source: 'Ethiopian National TB/HIV Guidelines (2022)' });
  }

  // ── HIV / ART ─────────────────────────────────────────────────────────────
  const hasHIVOnART = containsAny(mergedSymptomContext, ['hiv positive', 'art', 'antiretroviral', 'known hiv', 'plhiv', 'on art', 'haart']);
  const hasHIVRiskSigns = containsAny(mergedSymptomContext, [
    'recurrent infection', 'oral thrush', 'candida', 'herpes zoster', 'wasting',
    'generalised lymphadenopathy', 'unexplained weight loss', 'kaposi', 'oesophageal candida',
  ]);

  if (hasHIVRiskSigns && !hasHIVOnART) {
    pushIssue(warnings, 'CDSS_WARN_HIV_TEST_INDICATED', 'CDSS-SW-007', 'Clinical features suggest possible HIV. Offer HIV rapid test with counselling per HCT/PITC protocol.');
    recommendations.push({ text: 'Offer HIV rapid test (consent required). If positive: baseline CD4, WHO staging, screen for TB, initiate ART same day per Test-and-Treat guideline.', source: 'Ethiopian HIV Testing and Treatment Guideline' });
  }
  if (hasHIVOnART) {
    pushIssue(warnings, 'CDSS_WARN_HIV_ART_ADHERENCE', 'CDSS-SW-008', 'Patient on ART: review adherence, viral load/CD4 status, screen for TB co-infection and opportunistic infections.');
    recommendations.push({ text: 'Assess ART adherence (pill count, VL). Screen for TB (symptoms + Xpert if indicated). Check for OIs. Refill ART supply for uninterrupted treatment. Document in ART register.', source: 'Ethiopian HIV Treatment Guideline' });
  }

  // ── ACUTE MALNUTRITION ───────────────────────────────────────────────────
  const muacCm = typeof (input.vitals as any).muacCm === 'number' ? (input.vitals as any).muacCm : null;
  const hasSAMSigns = containsAny(mergedSymptomContext, [
    'severe acute malnutrition', ' sam ', 'marasmus', 'kwashiorkor',
    'bilateral pitting oedema', 'bilateral oedema', 'nutritional oedema',
  ]);
  const hasMAMSigns = containsAny(mergedSymptomContext, ['moderate acute malnutrition', ' mam ', 'moderate malnutrition']);

  if (cohort === 'pediatric') {
    const muacSamThreshCm = (ruleset as any).thresholds.muacSamThresholdMm / 10;
    const muacMamThreshCm = (ruleset as any).thresholds.muacMamThresholdMm / 10;
    const hasSamComplication = containsAny(mergedSymptomContext, [
      'not eating', 'not drinking', 'lethargy', 'infection', 'fever', 'diarrhea', 'diarrhoea',
      'vomiting', 'oedema', 'edema', 'severe anaemia', 'severe anemia',
    ]);
    if ((muacCm !== null && muacCm < muacSamThreshCm) || hasSAMSigns) {
      if (hasSamComplication) {
        pushIssue(hardStops, 'CDSS_HARD_PEDIATRIC_SAM_COMPLICATIONS', 'CDSS-HS-013', 'SAM with medical complications. Refer immediately to inpatient therapeutic feeding unit (TFU/SC).');
      } else {
        pushIssue(warnings, 'CDSS_WARN_SAM_DETECTED', 'CDSS-SW-009', 'SAM without complications (MUAC <11.5cm). Initiate OTP: RUTF, amoxicillin prophylaxis, de-worming, Vitamin A.');
        recommendations.push({ text: 'OTP: RUTF sachet per weight band (200–260kcal/kg/day). Amoxicillin 15mg/kg twice daily × 7 days. De-worm + Vitamin A dose. Weekly follow-up weight/MUAC.', source: 'Ethiopian CMAM National Protocol' });
      }
    } else if ((muacCm !== null && muacCm >= muacSamThreshCm && muacCm < muacMamThreshCm) || hasMAMSigns) {
      pushIssue(warnings, 'CDSS_WARN_MAM_DETECTED', 'CDSS-SW-010', 'MAM (MUAC 11.5–12.5cm). Refer to SFP. Treat underlying illness. Monthly weight/MUAC follow-up.');
      recommendations.push({ text: 'Refer to Supplementary Feeding Programme (SFP). Treat any illness. Nutrition counselling for caregiver. Monthly review. Escalate to OTP if deteriorates to SAM.', source: 'Ethiopian CMAM National Protocol' });
    }
  }

  // ── ANAEMIA ──────────────────────────────────────────────────────────────
  const hasAnaemiaSigns = containsAny(mergedSymptomContext, [
    'pallor', 'pale conjunctiva', 'pale palms', 'anemia', 'anaemia',
    'low hemoglobin', 'low haemoglobin', 'low hb', 'breathless on exertion',
  ]);
  if (hasAnaemiaSigns) {
    pushIssue(warnings, 'CDSS_WARN_ANEMIA_SUSPECTED', 'CDSS-SW-011', 'Anaemia signs present. Check Hb/haematocrit. Severe anaemia (Hb <7g/dL) requires urgent management.');
    recommendations.push({ text: 'Check Hb. Treat underlying cause. If Hb <7g/dL: urgent referral for transfusion evaluation. Iron-folic acid supplementation if iron-deficiency suspected. Treat malaria/helminthiasis if present.', source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)' });
  }

  // ── MATERNAL-SPECIFIC ────────────────────────────────────────────────────
  if (cohort === 'maternal') {
    if (containsAny(mergedSymptomContext, ['convulsion', 'seizure', 'eclampsia', 'fitting'])) {
      if (!hardStops.find((h) => h.code === 'CDSS_HARD_MATERNAL_SEVERE_HYPERTENSION')) {
        pushIssue(hardStops, 'CDSS_HARD_MATERNAL_ECLAMPSIA', 'CDSS-HS-011', 'Eclampsia. Protect airway. MgSO4 4g IV over 20 min + 10g IM. Emergency obstetric transfer.');
      }
    }

    if (containsAny(mergedSymptomContext, ['postpartum hemorrhage', 'postpartum haemorrhage', 'pph', 'excessive bleeding after delivery', 'heavy bleeding after birth', 'bleeding after birth'])) {
      pushIssue(hardStops, 'CDSS_HARD_MATERNAL_PPH', 'CDSS-HS-012', 'Postpartum haemorrhage. Bimanual compression + oxytocin 10 IU IM/IV + IV fluids. Emergency obstetric transfer immediately.');
    }

    if (
      bp &&
      bp.systolic >= (ruleset as any).thresholds.maternalPreeclampsiaSpSystolic &&
      bp.systolic < (ruleset as any).thresholds.maternalSevereBpSystolic &&
      bp.diastolic >= (ruleset as any).thresholds.maternalPreeclampsiaDiastolic
    ) {
      pushIssue(warnings, 'CDSS_WARN_PREECLAMPSIA_MILD', 'CDSS-SW-012', 'Elevated BP in pregnancy (140–159/90–109). Dipstick for proteinuria. Increase ANC frequency. Low-dose aspirin if <20 weeks.');
      recommendations.push({ text: 'Dipstick for proteinuria. Increase ANC frequency. Low-dose aspirin 75–150mg daily if <20 weeks. Refer urgently if BP worsens above 160/110 or symptoms appear.', source: 'Ethiopian Obstetrics and Gynaecology Guideline' });
    }

    const hivTestDocumented = containsAny(mergedSymptomContext, ['hiv test', 'hiv result', 'hiv positive', 'hiv negative', 'pmtct', 'art in pregnancy', 'option b']);
    if (!hivTestDocumented) {
      pushIssue(warnings, 'CDSS_WARN_PMTCT_HIV_TEST', 'CDSS-SW-013', 'HIV status not documented. Offer HIV and syphilis test at first ANC per PMTCT Option B+ protocol.');
      recommendations.push({ text: 'Test for HIV and syphilis at first ANC. If HIV-positive: initiate ART immediately (Option B+), plan safe delivery, and start infant prophylaxis. Register in PMTCT register.', source: 'Ethiopian PMTCT Programme Guidelines (2021)' });
    }

    const ironFolateDocumented = containsAny(mergedSymptomContext, ['iron supplement', 'ferrous', 'iron folate', 'iron folic', 'antenatal iron', 'folic acid', 'folic prescribed']);
    if (!ironFolateDocumented) {
      pushIssue(warnings, 'CDSS_WARN_ANTENATAL_IRON_FOLATE', 'CDSS-SW-014', 'Iron-folic acid supplementation not documented. Prescribe daily iron-folate for all pregnant women per ANC protocol.');
      recommendations.push({ text: 'Prescribe daily iron-folate (60mg elemental iron + 400mcg folic acid). Continue throughout pregnancy and 3 months postpartum. Counsel on taking with food to reduce GI side effects.', source: 'Ethiopian ANC Guideline / RMNCH' });
    }
  }

  // ── RESPIRATORY / PNEUMONIA / ASTHMA ─────────────────────────────────────
  const hasFever = typeof input.vitals.temperature === 'number' && input.vitals.temperature >= (ruleset as any).thresholds.adultFeverThresholdC;
  const hasCough = containsAny(mergedSymptomContext, ['cough', 'productive cough', 'dry cough', 'wet cough']);
  const isWheeze = containsAny(mergedSymptomContext, ['wheeze', 'wheezing', 'expiratory wheeze', 'asthma', 'recurrent wheeze', 'nocturnal cough', 'shortness of breath recurrent']);

  const hasFastBreathing =
    typeof input.vitals.respiratoryRate === 'number' &&
    (cohort !== 'pediatric'
      ? input.vitals.respiratoryRate >= (ruleset as any).thresholds.adultTachypnoeaThreshold
      : hasDangerRespRate(ageYears, input.vitals.respiratoryRate));

  if (hasFastBreathing && (hasFever || hasCough) && !hardStops.find((h) => h.code === 'CDSS_HARD_PEDIATRIC_RESP_DISTRESS')) {
    pushIssue(warnings, 'CDSS_WARN_PNEUMONIA_FAST_BREATHING', 'CDSS-SW-015', 'Fast breathing with fever/cough — classify pneumonia per IMNCI. Amoxicillin weight-based. Reassess at 48 hours.');
    recommendations.push({
      text: cohort === 'pediatric'
        ? 'IMNCI: fast breathing without chest indrawing = pneumonia (amoxicillin 40mg/kg/day divided BD × 5 days). Chest indrawing = severe (refer + pre-referral amoxicillin). Monitor SpO2.'
        : 'Pneumonia: amoxicillin-clavulanate 625mg TDS × 7 days or azithromycin 500mg OD × 3 days for atypical. Oxygen if SpO2 <94%. Refer if not responding at 48 hours.',
      source: 'Ethiopian IMNCI/Standard Treatment Guidelines'
    });
  }

  if (isWheeze && !hardStops.find((h) => h.code === 'CDSS_HARD_PEDIATRIC_RESP_DISTRESS')) {
    pushIssue(warnings, 'CDSS_WARN_ASTHMA_SUSPECTED', 'CDSS-SW-016', 'Wheeze/asthma features. Salbutamol MDI + spacer for acute attack. Prednisolone if moderate/severe. Refer if no response.');
    recommendations.push({ text: 'Acute asthma: salbutamol 2.5mg nebulisation or 4–8 puffs MDI + spacer every 20 min × 3. Add prednisolone 1mg/kg if moderate/severe. Refer if severe or no response after 1 hour.', source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)' });
  }

  // ── DIARRHOEA / DEHYDRATION ───────────────────────────────────────────────
  const hasDiarrhoea = containsAny(mergedSymptomContext, ['diarrhea', 'diarrhoea', 'watery stool', 'loose stool', 'frequent stool', 'loose motions']);
  const hasSevereDehydration = containsAny(mergedSymptomContext, [
    'unable to drink', 'sunken eyes severe', 'very slow skin pinch', 'severe dehydration',
    'lethargic dehydrated', 'unconscious dehydrated', 'absent radial pulse', 'cholera suspect',
  ]);
  const hasModerateDehydration = hasDiarrhoea && !hasSevereDehydration && containsAny(mergedSymptomContext, [
    'sunken eyes', 'thirsty', 'restless dehydrated', 'slow skin pinch', 'some dehydration', 'moderate dehydration',
  ]);

  if (hasDiarrhoea && hasSevereDehydration) {
    pushIssue(hardStops, 'CDSS_HARD_SEVERE_DEHYDRATION', 'CDSS-HS-014', 'Severe dehydration. IV Ringer\'s Lactate 100mL/kg immediately (Plan C). Refer if IV access not possible.');
  } else if (hasModerateDehydration) {
    pushIssue(warnings, 'CDSS_WARN_DEHYDRATION_MODERATE', 'CDSS-SW-017', 'Moderate dehydration. ORS 75mL/kg over 4 hours (Plan B). Zinc supplementation. Reassess every hour.');
    recommendations.push({ text: 'Plan B: ORS 75mL/kg over 4 hours. Zinc: 10mg/day (<6m) or 20mg/day (≥6m) × 10 days. Continue breastfeeding/feeding. Return immediately if unable to drink, stool >6/day, or vomiting everything.', source: 'WHO/Ethiopian IMNCI Guideline' });
  }

  // ── NEONATAL DANGER SIGNS ────────────────────────────────────────────────
  if (cohort === 'pediatric' && ageYears !== null && ageYears < 0.084) {
    const hasNeonatalDanger = containsAny(mergedSymptomContext, [
      'not feeding', 'unable to breastfeed', 'convulsion', 'neonatal convulsion', 'fast breathing neonate',
      'jaundice', 'neonatal jaundice', 'hypothermia neonate', 'hyperthermia neonate',
      'bulging fontanelle', 'umbilical infection', 'reduced movement', 'lethargic neonate',
      'pallor neonate', 'grunting', 'cyanosis neonate',
    ]);
    if (hasNeonatalDanger) {
      pushIssue(hardStops, 'CDSS_HARD_NEONATAL_DANGER', 'CDSS-HS-015', 'Neonatal danger signs. Stabilise: warmth, clear airway, dextrose. Emergency neonatal unit referral immediately.');
    }
  }

  // ── HYPERTENSION (NON-MATERNAL) ──────────────────────────────────────────
  if (cohort !== 'maternal' && bp) {
    const hasHtEmergencySx = containsAny(mergedSymptomContext, [
      'chest pain', 'shortness of breath acute', 'severe headache hypertension', 'visual change',
      'confusion hypertension', 'focal weakness', 'stroke', 'heart failure', 'acute pulmonary oedema',
    ]);
    if (bp.systolic >= (ruleset as any).thresholds.hyperBpSystolicEmergency || bp.diastolic >= (ruleset as any).thresholds.hyperBpDiastolicEmergency) {
      if (hasHtEmergencySx) {
        pushIssue(hardStops, 'CDSS_HARD_HYPERTENSIVE_EMERGENCY', 'CDSS-HS-016', 'Hypertensive emergency (BP ≥180/120 with end-organ symptoms). IV labetalol/oral nifedipine. ECG. Emergency referral.');
      } else {
        pushIssue(warnings, 'CDSS_WARN_HYPERTENSION_UNCONTROLLED', 'CDSS-SW-018', 'BP ≥180/120 — urgently elevated. Assess for end-organ damage. Start/intensify antihypertensive now.');
        recommendations.push({ text: 'Recheck after 15 min rest. If persistently ≥180/120: oral nifedipine 10mg. Arrange same-day review at district hospital. Intensify long-term antihypertensive regimen.', source: 'Ethiopian NCD Guideline' });
      }
    } else if (bp.systolic >= (ruleset as any).thresholds.hyperBpSystolicWarning || bp.diastolic >= (ruleset as any).thresholds.hyperBpDiastolicWarning) {
      pushIssue(warnings, 'CDSS_WARN_HYPERTENSION_UNCONTROLLED', 'CDSS-SW-018', 'Elevated BP (≥140/90). Confirm on repeat reading. Initiate/optimise antihypertensive. Lifestyle counselling.');
      recommendations.push({ text: 'Lifestyle modification: low-salt diet, weight control, physical activity, no smoking. Pharmacotherapy: amlodipine 5mg OD or HCTZ 12.5–25mg as first-line. Schedule follow-up in 2–4 weeks.', source: 'Ethiopian NCD Guideline' });
    }
  }

  // ── DIABETES / HYPERGLYCAEMIA ─────────────────────────────────────────────
  const hasDiabetesContext = containsAny(mergedSymptomContext, [
    'diabetes', 'diabetic', 'hyperglycemia', 'hyperglycaemia', 'high blood sugar',
    'insulin', 'metformin', 'polydipsia', 'polyuria', 'random glucose high',
  ]);
  if (hasDiabetesContext) {
    pushIssue(warnings, 'CDSS_WARN_DIABETES_HYPERGLYCEMIA', 'CDSS-SW-022', 'Diabetes or elevated glucose. Check fasting/random glucose. Optimise control. Screen for complications.');
    recommendations.push({ text: 'FBS target <7mmol/L (126mg/dL). Metformin 500mg BD as first-line type 2. Lifestyle counselling. Screen for foot (monofilament), kidney (urine dipstick), and eye complications annually.', source: 'Ethiopian NCD Guideline' });
  }

  // ── ANAPHYLAXIS ──────────────────────────────────────────────────────────
  const hasAnaphylaxis = containsAny(mergedSymptomContext, [
    'anaphylaxis', 'anaphylactic', 'severe allergic reaction', 'throat swelling', 'throat tightness',
    'angioedema', 'urticaria and hypotension', 'sting collapse', 'bee sting anaphylaxis', 'drug anaphylaxis',
  ]);
  if (hasAnaphylaxis) {
    pushIssue(hardStops, 'CDSS_HARD_ANAPHYLAXIS', 'CDSS-HS-017', 'Anaphylaxis. Epinephrine 0.5mg IM (adult) / 0.01mg/kg IM (child) immediately into outer thigh. Supine, IV access. Emergency transfer.');
  }

  // ── SEPSIS ───────────────────────────────────────────────────────────────
  const isFeverOrHypothermia =
    (typeof input.vitals.temperature === 'number' && (input.vitals.temperature >= 38.5 || input.vitals.temperature < 36.0));
  const isTachycardic = typeof input.vitals.heartRate === 'number' && input.vitals.heartRate >= (ruleset as any).thresholds.adultTachycardiaThreshold;
  const isRespElevated = typeof input.vitals.respiratoryRate === 'number' && input.vitals.respiratoryRate >= (ruleset as any).thresholds.adultTachypnoeaThreshold;
  const hasInfectionSource = containsAny(mergedSymptomContext, [
    'infection', 'abscess', 'peritonitis', 'pyelonephritis', 'pneumonia severe',
    'meningitis', 'wound infection', 'cellulitis extensive', 'infected wound', 'septic',
  ]);
  if (isFeverOrHypothermia && isTachycardic && isRespElevated && hasInfectionSource) {
    if (!hardStops.find((h) => h.code === 'CDSS_HARD_FEVER_NECK_STIFFNESS')) {
      pushIssue(hardStops, 'CDSS_HARD_SEPSIS_SUSPECTED', 'CDSS-HS-018', 'Sepsis criteria met (fever + tachycardia + tachypnoea + infection source). IV ceftriaxone 2g within 1 hour. IV fluids 30mL/kg. Urgent referral.');
    }
  }

  // ── MENTAL HEALTH ────────────────────────────────────────────────────────
  const hasMentalHealthConcern = containsAny(mergedSymptomContext, [
    'suicidal', 'self harm', 'self-harm', 'psychosis', 'acute confusion', 'mania',
    'severe depression', 'aggressive behaviour', 'hallucination', 'hearing voices',
    'seeing things', 'paranoia', 'mhgap', 'mental illness', 'psychiatric',
  ]);
  if (hasMentalHealthConcern) {
    pushIssue(warnings, 'CDSS_WARN_MENTAL_HEALTH_SCREENING', 'CDSS-SW-019', 'Mental health concern. Apply mhGAP assessment. Assess suicide risk. Do not leave high-risk patient alone. Involve caregiver.');
    recommendations.push({ text: 'Use mhGAP-IG v2.0. Suicide risk: do not leave alone, involve family, consider admission. Psychosis: haloperidol 5mg IM (adult). Refer to mental health team or higher facility if beyond PHC capacity.', source: 'WHO mhGAP Intervention Guide v2.0' });
  }

  // ── ANTIBIOTIC STEWARDSHIP ───────────────────────────────────────────────
  const hasBroadSpectrumRequest = containsAny(mergedSymptomContext, [
    'ciprofloxacin', 'ceftriaxone oral', 'broad spectrum antibiotic', 'augmentin routine',
    'amoxiclav urti', 'cefixime', 'meropenem', 'antibiotic for viral', 'antibiotics for cold',
  ]);
  if (hasBroadSpectrumRequest) {
    pushIssue(warnings, 'CDSS_WARN_ANTIBIOTIC_STEWARDSHIP', 'CDSS-SW-020', 'Broad-spectrum antibiotic considered. Confirm bacterial infection, use narrowest effective agent, document indication and duration.');
    recommendations.push({ text: 'Apply stewardship: (1) confirm bacterial infection, (2) check allergy, (3) use first-line per Ethiopia STG, (4) document indication + duration, (5) review culture when available. Avoid fluoroquinolones as first-line for community infections.', source: 'Ethiopian Antimicrobial Stewardship National Action Plan' });
  }

  // ── DRUG ALLERGY CHECK ───────────────────────────────────────────────────
  const hasDocumentedAllergy = containsAny(mergedSymptomContext, ['known allergy', 'documented allergy', 'drug allergy', 'allergic to', 'penicillin allergy', 'sulfa allergy', 'allergy documented']);
  if (hasDocumentedAllergy) {
    pushIssue(warnings, 'CDSS_WARN_DRUG_ALLERGY_CHECK', 'CDSS-SW-023', 'Documented drug allergy. Cross-check all prescriptions against allergy list before dispensing.');
  }

  // Mark split between condition-specific recs (from symptom matching above) and
  // result-confirmed recs (from actual lab/imaging values below).
  // Result-confirmed recs have highest priority — they are certain, not suspected.
  const conditionRecsCount = recommendations.length;

  // ── RESULT INTERPRETATION ────────────────────────────────────────────────
  // Parse key numerical values and positive/negative flags from actual results.
  // Generates severity-specific recommendations that symptom text alone cannot.
  for (const lab of input.labResults) {
    const nameLower = lab.name.toLowerCase();
    const valueLower = lab.value.toLowerCase();

    // Haemoglobin — severity-graded anaemia management
    if (nameLower.includes('hb') || nameLower.includes('hemoglobin') || nameLower.includes('haemoglobin')) {
      const hbMatch = lab.value.match(/(\d+\.?\d*)/);
      if (hbMatch) {
        const hb = parseFloat(hbMatch[1]);
        if (hb < 7) {
          pushIssue(hardStops, 'CDSS_RESULT_SEVERE_ANAEMIA', 'CDSS-R-001',
            `Severe anaemia: Hb ${hb} g/dL. Urgent referral for transfusion evaluation. Give iron + treat underlying cause.`);
        } else if (hb < 10) {
          if (!warnings.find(w => w.code === 'CDSS_WARN_ANEMIA_SUSPECTED')) {
            pushIssue(warnings, 'CDSS_RESULT_MODERATE_ANAEMIA', 'CDSS-R-002',
              `Moderate anaemia: Hb ${hb} g/dL. Iron supplementation and treat underlying cause. Repeat CBC in 4 weeks.`);
          }
          recommendations.push({
            text: `Moderate anaemia (Hb ${hb} g/dL): ferrous sulfate 200mg TDS for 3 months. Treat underlying cause (malaria/helminth). Dietary counselling. Repeat CBC in 4 weeks.`,
            source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)'
          });
        }
      }
    }

    // Blood glucose — hypoglycaemia and hyperglycaemia
    if (nameLower.includes('glucose') || nameLower.includes('rbs') || nameLower.includes('fbs') || nameLower.includes('blood sugar')) {
      const glcMatch = lab.value.match(/(\d+\.?\d*)/);
      if (glcMatch) {
        const glc = parseFloat(glcMatch[1]);
        const isMmol = valueLower.includes('mmol');
        const glcMgDl = isMmol ? glc * 18 : glc;
        if (glcMgDl < 70) {
          pushIssue(hardStops, 'CDSS_RESULT_HYPOGLYCAEMIA', 'CDSS-R-003',
            `Hypoglycaemia: glucose ${lab.value}. Give oral glucose (if conscious) or 50% dextrose 25mL IV. Recheck in 15 minutes.`);
        } else if (glcMgDl > 400) {
          pushIssue(hardStops, 'CDSS_RESULT_SEVERE_HYPERGLYCAEMIA', 'CDSS-R-004',
            `Severe hyperglycaemia: glucose ${lab.value}. Assess for DKA (ketones, pH). IV fluids + insulin protocol. Urgent referral.`);
        } else if (glcMgDl > 200) {
          pushIssue(warnings, 'CDSS_RESULT_HYPERGLYCAEMIA', 'CDSS-R-005',
            `Elevated glucose ${lab.value}. Optimise diabetes management. Check HbA1c if not recently done.`);
          recommendations.push({
            text: `Glucose ${lab.value} — optimise DM control: review medications, reinforce dietary adherence. Target FBS <7 mmol/L (126 mg/dL). Consider adding/intensifying insulin if oral agents inadequate.`,
            source: 'Ethiopian NCD Guideline'
          });
        }
      }
    }

    // Malaria RDT — P. vivax requires different regimen (primaquine)
    if ((nameLower.includes('malaria') || nameLower.includes('rdt') || nameLower.includes('rapid malaria')) &&
        (valueLower.includes('positive') || valueLower.includes('pos') || valueLower.includes('+'))) {
      if (valueLower.includes('vivax') || valueLower.includes('p.v') || valueLower.includes('pv')) {
        recommendations.push({
          text: 'P. vivax confirmed: chloroquine 25mg base/kg over 3 days. Add primaquine 0.25mg/kg/day × 14 days after checking G6PD status. Do not give primaquine in pregnancy.',
          source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)'
        });
      }
    }

    // Sputum / Xpert — TB confirmed
    if ((nameLower.includes('sputum') || nameLower.includes('xpert') || nameLower.includes('afb') || nameLower.includes('mtb')) &&
        (valueLower.includes('positive') || valueLower.includes('detected') || valueLower.includes('reactive'))) {
      if (!warnings.find(w => w.code === 'CDSS_RESULT_TB_CONFIRMED')) {
        pushIssue(warnings, 'CDSS_RESULT_TB_CONFIRMED', 'CDSS-R-006',
          `TB confirmed (${lab.name}: ${lab.value}). Register in TB register. Initiate Category I regimen. Notify household contacts.`);
        recommendations.push({
          text: `TB confirmed: initiate 2RHZE/4RH (Category I). Register in TB register. Notify and screen household contacts. HIV test if status unknown. Baseline LFT before rifampicin.`,
          source: 'Ethiopian National TB Guidelines (2022)'
        });
      }
    }

    // HIV rapid test reactive
    if ((nameLower.includes('hiv') || nameLower.includes('hiv rapid')) &&
        (valueLower.includes('positive') || valueLower.includes('reactive'))) {
      if (!warnings.find(w => w.code === 'CDSS_RESULT_HIV_REACTIVE')) {
        pushIssue(warnings, 'CDSS_RESULT_HIV_REACTIVE', 'CDSS-R-007',
          `HIV rapid test reactive. Confirm with WHO serial algorithm. Baseline CD4, WHO staging, screen for TB. Initiate ART same day per Test-and-Treat.`);
        recommendations.push({
          text: `HIV reactive: confirm with second rapid test. If confirmed: baseline CD4, WHO staging, screen for TB and OIs. Initiate ART same day — TLE (tenofovir + lamivudine + efavirenz) as preferred first-line. Enrol in ART register.`,
          source: 'Ethiopian HIV Testing and Treatment Guideline'
        });
      }
    }

    // WBC — leukocytosis / leukopenia
    if (nameLower.includes('wbc') || nameLower.includes('white blood cell') || nameLower.includes('total wbc')) {
      const wbcMatch = lab.value.match(/(\d+\.?\d*)/);
      if (wbcMatch) {
        const raw = parseFloat(wbcMatch[1]);
        // Normalise to 10³/μL — values >200 are likely absolute counts
        const wbcK = raw > 200 ? raw / 1000 : raw;
        if (wbcK > 30) {
          pushIssue(warnings, 'CDSS_RESULT_MARKED_LEUKOCYTOSIS', 'CDSS-R-008',
            `Marked leukocytosis: WBC ${lab.value}. Consider severe bacterial infection or haematological malignancy. Blood film and urgent review.`);
        } else if (wbcK > 12) {
          pushIssue(warnings, 'CDSS_RESULT_LEUKOCYTOSIS', 'CDSS-R-009',
            `Leukocytosis: WBC ${lab.value}. Correlates with bacterial infection or physiological stress. Treat underlying cause.`);
        } else if (wbcK < 3) {
          pushIssue(warnings, 'CDSS_RESULT_LEUKOPENIA', 'CDSS-R-010',
            `Leukopenia: WBC ${lab.value}. Evaluate for viral infection (HIV, dengue), drug effect, or haematological disorder.`);
        }
      }
    }

    // Urine dipstick — UTI and proteinuria
    if (nameLower.includes('urine') || nameLower.includes('urinalysis') || nameLower.includes('dipstick') || nameLower.includes('ua ')) {
      if (valueLower.includes('nitrite') && (valueLower.includes('positive') || valueLower.includes('+'))) {
        pushIssue(warnings, 'CDSS_RESULT_UTI_DIPSTICK', 'CDSS-R-011',
          `Urine dipstick nitrite positive — UTI. Trimethoprim-sulfamethoxazole or amoxicillin × 5–7 days. Send urine C&S if recurrent.`);
        recommendations.push({
          text: `UTI: co-trimoxazole 960mg BD × 5 days (non-pregnant adults). Pregnancy: amoxicillin 500mg TDS × 7 days. Upper UTI or pyelonephritis: ciprofloxacin 500mg BD × 7 days. Send urine C&S if recurrent.`,
          source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)'
        });
      }
      if (/2\+|3\+|\+\+/.test(valueLower) && valueLower.includes('protein')) {
        if (cohort === 'maternal') {
          pushIssue(warnings, 'CDSS_RESULT_PROTEINURIA_MATERNAL', 'CDSS-R-012',
            `Significant proteinuria in pregnancy — combined with elevated BP indicates pre-eclampsia. Urgent obstetric review.`);
        } else {
          pushIssue(warnings, 'CDSS_RESULT_PROTEINURIA', 'CDSS-R-013',
            `Significant proteinuria (2+/3+). Evaluate for nephrotic syndrome, diabetic nephropathy, or hypertensive nephropathy.`);
        }
      }
    }
  }

  // Imaging result interpretation
  for (const img of input.imagingResults) {
    const studyLower = img.study.toLowerCase();
    const findingsLower = img.findings.toLowerCase();

    // CXR — infiltrates / consolidation → pneumonia management
    if ((studyLower.includes('chest') || studyLower.includes('cxr') || studyLower.includes('chest x')) &&
        (findingsLower.includes('infiltrat') || findingsLower.includes('consolidat') || findingsLower.includes('opacity') || findingsLower.includes('haziness'))) {
      pushIssue(warnings, 'CDSS_RESULT_CXR_INFILTRATES', 'CDSS-R-014',
        `CXR: ${img.findings}. Consistent with pneumonia. Initiate antibiotic treatment; oxygen if SpO2 <94%.`);
      recommendations.push({
        text: `CXR infiltrates/consolidation — community-acquired pneumonia: amoxicillin-clavulanate 625mg TDS × 7 days or azithromycin 500mg OD × 3 days (atypical). Assess severity (CURB-65). Oxygen if SpO2 <94%. Refer if CURB-65 ≥2.`,
        source: 'Ethiopian Standard Treatment Guidelines (MoH 2020)'
      });
    }

    // CXR — pleural effusion
    if ((studyLower.includes('chest') || studyLower.includes('cxr')) &&
        (findingsLower.includes('pleural effusion') || findingsLower.includes('effusion'))) {
      pushIssue(warnings, 'CDSS_RESULT_PLEURAL_EFFUSION', 'CDSS-R-015',
        `Pleural effusion on CXR. Evaluate cause (TB, cardiac failure, malignancy). Refer for thoracentesis if large or cause unclear.`);
    }

    // Abdominal ultrasound — surgical emergency signs
    if ((studyLower.includes('abdomen') || studyLower.includes('abdominal') || studyLower.includes('ultrasound') || studyLower.includes('fast')) &&
        (findingsLower.includes('free fluid') || findingsLower.includes('perforation') || findingsLower.includes('abscess'))) {
      pushIssue(hardStops, 'CDSS_RESULT_ACUTE_ABDOMEN_IMAGING', 'CDSS-R-016',
        `Abdominal imaging: ${img.findings}. Possible surgical emergency — urgent surgical referral.`);
    }

    // ECG — STEMI and atrial fibrillation
    if (studyLower.includes('ecg') || studyLower.includes('electrocardiogram') || studyLower.includes('ekg')) {
      if (findingsLower.includes('st elevation') || findingsLower.includes('stemi')) {
        pushIssue(hardStops, 'CDSS_RESULT_STEMI', 'CDSS-R-017',
          `ECG: ST elevation — STEMI. Aspirin 300mg + clopidogrel 300mg stat. Urgent cardiac referral for PCI or thrombolysis.`);
      } else if (findingsLower.includes('atrial fibrillation') || findingsLower.includes(' af ') || findingsLower.includes('af,') || findingsLower.includes('irregular rhythm')) {
        pushIssue(warnings, 'CDSS_RESULT_AF_ECG', 'CDSS-R-018',
          `ECG: atrial fibrillation. Assess haemodynamic stability. Rate control (digoxin/metoprolol) and anticoagulation. Cardiology referral.`);
      }
    }
  }

  // Suppress "order X" recommendations when results for that test already exist
  if (resultNames.size > 0) {
    const suppressMap: Array<[string, RegExp]> = [
      ['malaria', /\border\s+(malaria|rdt|rapid malaria)\b/i],
      ['cbc',     /\border\s+(cbc|full blood count|blood count)\b/i],
      ['glucose', /\border\s+(blood glucose|fasting blood sugar|random blood sugar|rbs|fbs)\b/i],
      ['hiv',     /\border\s+(hiv rapid|hiv test)\b/i],
      ['urine',   /\border\s+(urinalysis|urine dipstick)\b/i],
      ['sputum',  /\border\s+(sputum|xpert|afb)\b/i],
    ];
    for (const [key, orderPattern] of suppressMap) {
      const hasResult = [...resultNames].some(n => n.includes(key));
      if (hasResult) {
        for (let i = recommendations.length - 1; i >= 0; i--) {
          if (orderPattern.test(recommendations[i].text)) {
            recommendations.splice(i, 1);
          }
        }
      }
    }
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

  // ── PRIORITISED RECOMMENDATION PIPELINE ─────────────────────────────────
  // Priority order (highest → lowest):
  //   1. Emergency        — hard-stops fire; recommendations suppressed entirely
  //   2. Result-confirmed — actual lab/imaging values drove the recommendation
  //   3. Focused ladder   — chief-complaint × workup-state decision tree
  //   4. Condition-match  — broad symptom-pattern recs (kept as fallback only)
  //   5. Baseline         — generic boilerplate (last resort)
  const resultConfirmedRecs = recommendations.slice(conditionRecsCount);
  const conditionSpecificRecs = recommendations.slice(0, conditionRecsCount);
  const focusedStep = buildFocusedNextStep(input, mergedSymptomContext, cohort);

  let finalRecs: CdsRecommendation[];
  if (hardStops.length > 0) {
    // Emergency: the hard-stop IS the next step. No additional recs.
    finalRecs = [];
  } else if (resultConfirmedRecs.length > 0) {
    // Results are back and interpreted: show confirmed recs (max 2).
    finalRecs = resultConfirmedRecs.slice(0, 2);
  } else if (focusedStep) {
    // Chief-complaint ladder identified one clear next action.
    finalRecs = [focusedStep];
  } else if (conditionSpecificRecs.length > 0) {
    // Broad symptom match, no focused step — take the single highest-ranked match.
    finalRecs = conditionSpecificRecs.slice(0, 1);
  } else {
    // Nothing patient-specific matched. Stay silent — generic reminders add noise,
    // not guidance. The advisor should only speak when it has something actionable.
    finalRecs = [];
  }

  // Consultation phase — tells the frontend what kind of guidance is appropriate now.
  const hasResults = input.labResults.length > 0 || input.imagingResults.length > 0;
  const hasDiagnosis = normalizeText(input.diagnosis).length > 0;
  const consultationPhase =
    hardStops.length > 0              ? 'emergency'
    : hasResults && hasDiagnosis      ? 'treatment'
    : hasResults                      ? 'interpret_results'
    : input.pendingOrders.length > 0  ? 'awaiting_results'
    : hasDiagnosis                    ? 'treatment'
    :                                   'diagnostic';

  const aiAdvisory = await maybeBuildAiAdvisory(input, cohort);
  const referralRequired = hardStops.length > 0;
  const briefSummary = buildBriefSummary({
    checkpoint,
    cohort,
    hardStops,
    warnings,
    referralRequired,
    topRecommendation: finalRecs[0],
  });

  return {
    success: true,
    algorithmVersion: (ruleset as any).version || 'unknown',
    algorithmName: (ruleset as any).name || 'CDSS',
    cohort,
    hardStops,
    warnings,
    recommendations: finalRecs,
    consultationPhase,
    referral: {
      required: referralRequired,
      urgency: hardStops.length === 0 ? null : hasEmergency ? 'emergency' : 'urgent',
      reasons: referralReasons,
    },
    briefSummary,
    aiAdvisory,
  };
};
