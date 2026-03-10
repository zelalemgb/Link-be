import { supabaseAdmin } from '../config/supabase';

type PatientRecordsSyncInput = {
  patientAccountId: string;
  tenantId?: string;
  maxVisits?: number;
  maxRecords?: number;
};

type SyncedRecordKind = 'visit_summary' | 'prescription' | 'lab_result' | 'referral_summary';

export type PatientSyncedRecord = {
  id: string;
  source: 'link_visit';
  synced: true;
  document_type: SyncedRecordKind;
  record_kind: SyncedRecordKind;
  document_date: string;
  provider_name: string | null;
  description: string;
  tags: string[];
  visit_id: string;
  visit_status: string | null;
  file_url: null;
  continuity_url: string;
  patient_app_deep_link: string;
};

export type PatientGrowthLinks = {
  patientAppDeepLink: string;
  patientAppInstallUrl: string;
  facilityFinderUrl: string;
  symptomCheckUrl: string;
  shareMessage: string;
};

export type PatientSyncedRecordsBundle = {
  records: PatientSyncedRecord[];
  counts: {
    visitSummaries: number;
    prescriptions: number;
    labResults: number;
    referralSummaries: number;
  };
  growth: PatientGrowthLinks;
};

const DEFAULT_MAX_VISITS = 30;
const DEFAULT_MAX_RECORDS = 80;

const sanitizeLimit = (value: number | undefined, fallback: number, max: number) => {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value as number);
  if (normalized < 1) return 1;
  return Math.min(max, normalized);
};

const toDateOnly = (value: unknown) => {
  if (!value) return new Date().toISOString().slice(0, 10);
  const raw = String(value).trim();
  if (!raw) return new Date().toISOString().slice(0, 10);
  const dateOnlyMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateOnlyMatch?.[1]) return dateOnlyMatch[1];
  const parsedMs = Date.parse(raw);
  if (!Number.isNaN(parsedMs)) {
    return new Date(parsedMs).toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
};

const asObject = (value: unknown): Record<string, any> | null => {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
    // no-op
  }
  return null;
};

const asArray = (value: unknown): any[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeText = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const parseVisitNotesDiagnosis = (visitNotes: unknown) => {
  const raw = normalizeText(visitNotes);
  if (!raw) return '';
  const parsedObject = asObject(raw);
  if (!parsedObject) return '';

  const customNotes = asObject(parsedObject.customNotes);
  return (
    normalizeText(customNotes?.diagnosis) ||
    normalizeText(parsedObject.diagnosis) ||
    normalizeText(customNotes?.observations)
  );
};

const summarizeDiagnoses = (diagnosesValue: unknown, visitNotes: unknown) => {
  const diagnoses = asArray(diagnosesValue);
  const names = diagnoses
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      return (
        normalizeText((entry as any).display_name) ||
        normalizeText((entry as any).diagnosis) ||
        normalizeText((entry as any).name) ||
        normalizeText((entry as any).title)
      );
    })
    .filter(Boolean);

  if (names.length > 0) return names.slice(0, 2).join(', ');
  return parseVisitNotesDiagnosis(visitNotes);
};

const buildVisitSummaryDescription = (visit: any) => {
  const complaint = normalizeText(visit.chief_complaint) || normalizeText(visit.reason) || 'Clinical visit completed';
  const diagnosis = summarizeDiagnoses(visit.diagnoses_json, visit.visit_notes);
  const outcome = normalizeText(visit.outcome);
  const followUp = normalizeText(visit.follow_up_date);

  const parts = [complaint];
  if (diagnosis) {
    parts.push(`Diagnosis: ${diagnosis}.`);
  }
  if (outcome) {
    parts.push(`Outcome: ${outcome}.`);
  } else if (followUp) {
    parts.push(`Follow-up planned on ${followUp}.`);
  }

  return parts.join(' ').trim();
};

const buildPrescriptionDescription = (order: any) => {
  const medication = normalizeText(order.medication_name) || 'Prescription';
  const parts = [medication];
  if (normalizeText(order.dosage)) parts.push(`Dose ${normalizeText(order.dosage)}`);
  if (normalizeText(order.frequency)) parts.push(normalizeText(order.frequency));
  if (normalizeText(order.duration)) parts.push(`for ${normalizeText(order.duration)}`);
  if (normalizeText(order.status)) parts.push(`(${normalizeText(order.status)})`);
  return parts.join(', ');
};

const buildLabDescription = (order: any) => {
  const testName = normalizeText(order.test_name) || 'Lab result';
  const value = normalizeText(order.result_value) || normalizeText(order.result);
  const status = normalizeText(order.status);

  if (value) {
    const range = normalizeText(order.reference_range);
    if (range) return `${testName}: ${value} (ref ${range})`;
    return `${testName}: ${value}`;
  }

  if (status) return `${testName}: ${status}`;
  return testName;
};

const buildReferralDescription = (visit: any, referralData: Record<string, any> | null) => {
  const destination = normalizeText(referralData?.destination);
  const urgency = normalizeText(referralData?.urgency);
  const reason = normalizeText(referralData?.reason);
  const transport = normalizeText(referralData?.transport);

  const parts = ['Referral summary'];
  if (destination) parts.push(`to ${destination}`);
  if (urgency) parts.push(`(${urgency})`);
  if (reason) parts.push(`Reason: ${reason}.`);
  if (transport) parts.push(`Transport: ${transport}.`);
  if (!reason && normalizeText(visit.outcome) === 'referred') {
    parts.push('Outcome marked as referred.');
  }
  return parts.join(' ').trim();
};

const isVisitReferral = (visit: any, referralData: Record<string, any> | null) => {
  if (normalizeText(visit.outcome) === 'referred') return true;
  if (!referralData) return false;

  if (referralData.is_referred === true) return true;
  if (referralData.isReferred === true) return true;

  return Boolean(
    normalizeText(referralData.destination) ||
      normalizeText(referralData.reason) ||
      normalizeText(referralData.urgency)
  );
};

const recordPriority: Record<SyncedRecordKind, number> = {
  visit_summary: 1,
  prescription: 2,
  lab_result: 3,
  referral_summary: 4,
};

const resolveFrontendBaseUrl = () => {
  const fallback = 'http://localhost:5173';
  const raw = String(process.env.FRONTEND_URL || fallback).trim();
  return raw.replace(/\/+$/, '') || fallback;
};

const buildGrowthLinks = (): PatientGrowthLinks => {
  const frontendBase = resolveFrontendBaseUrl();
  const facilityFinderUrl = `${frontendBase}/facility-finder`;
  const symptomCheckUrl = `${facilityFinderUrl}?intent=symptom-check`;
  const patientAppDeepLink = String(process.env.PATIENT_APP_DEEP_LINK || 'linkhealth://records').trim();
  const patientAppInstallUrl = String(process.env.PATIENT_APP_INSTALL_URL || `${facilityFinderUrl}?entry=patient-app`).trim();

  return {
    patientAppDeepLink,
    patientAppInstallUrl,
    facilityFinderUrl,
    symptomCheckUrl,
    shareMessage: `Use Link Patient to keep your records in one place. ${patientAppInstallUrl}`,
  };
};

const buildContinuityUrl = (facilityFinderUrl: string, visitId: string) => {
  const query = new URLSearchParams({
    source: 'visit-output',
    visit: visitId,
  });
  return `${facilityFinderUrl}?${query.toString()}`;
};

export const buildPatientSyncedRecords = async (
  input: PatientRecordsSyncInput
): Promise<PatientSyncedRecordsBundle> => {
  const maxVisits = sanitizeLimit(input.maxVisits, DEFAULT_MAX_VISITS, 60);
  const maxRecords = sanitizeLimit(input.maxRecords, DEFAULT_MAX_RECORDS, 200);
  const growthLinks = buildGrowthLinks();

  let patientQuery = supabaseAdmin
    .from('patients')
    .select('id')
    .eq('patient_account_id', input.patientAccountId);

  if (input.tenantId) {
    patientQuery = patientQuery.eq('tenant_id', input.tenantId);
  }

  const { data: patientRows, error: patientError } = await patientQuery;
  if (patientError) throw patientError;
  if (!patientRows || patientRows.length === 0) {
    return {
      records: [],
      counts: {
        visitSummaries: 0,
        prescriptions: 0,
        labResults: 0,
        referralSummaries: 0,
      },
      growth: growthLinks,
    };
  }

  const patientIds = patientRows.map((row: any) => row.id);

  let visitQuery = supabaseAdmin
    .from('visits')
    .select(
      'id, visit_date, created_at, chief_complaint, reason, provider, status, outcome, follow_up_date, visit_notes, diagnoses_json, referral_json'
    )
    .in('patient_id', patientIds)
    .order('visit_date', { ascending: false })
    .limit(maxVisits);

  if (input.tenantId) {
    visitQuery = visitQuery.eq('tenant_id', input.tenantId);
  }

  const { data: visits, error: visitsError } = await visitQuery;
  if (visitsError) throw visitsError;
  if (!visits || visits.length === 0) {
    return {
      records: [],
      counts: {
        visitSummaries: 0,
        prescriptions: 0,
        labResults: 0,
        referralSummaries: 0,
      },
      growth: growthLinks,
    };
  }

  const visitIds = visits.map((visit: any) => visit.id);
  const visitMap = new Map(visits.map((visit: any) => [visit.id, visit]));

  let medicationQuery = supabaseAdmin
    .from('medication_orders')
    .select('id, visit_id, medication_name, dosage, frequency, duration, route, status, ordered_at, dispensed_at')
    .in('visit_id', visitIds)
    .order('ordered_at', { ascending: false })
    .limit(maxRecords);

  if (input.tenantId) {
    medicationQuery = medicationQuery.eq('tenant_id', input.tenantId);
  }

  let labQuery = supabaseAdmin
    .from('lab_orders')
    .select('id, visit_id, test_name, status, result, result_value, reference_range, ordered_at, completed_at')
    .in('visit_id', visitIds)
    .order('completed_at', { ascending: false })
    .limit(maxRecords);

  if (input.tenantId) {
    labQuery = labQuery.eq('tenant_id', input.tenantId);
  }

  const [{ data: medicationOrders, error: medicationError }, { data: labOrders, error: labError }] =
    await Promise.all([medicationQuery, labQuery]);

  if (medicationError) throw medicationError;
  if (labError) throw labError;

  const records: PatientSyncedRecord[] = [];
  let visitSummaryCount = 0;
  let prescriptionCount = 0;
  let labResultCount = 0;
  let referralSummaryCount = 0;

  for (const visit of visits) {
    records.push({
      id: `synced-visit-${visit.id}`,
      source: 'link_visit',
      synced: true,
      document_type: 'visit_summary',
      record_kind: 'visit_summary',
      document_date: toDateOnly(visit.visit_date || visit.created_at),
      provider_name: normalizeText(visit.provider) || null,
      description: buildVisitSummaryDescription(visit),
      tags: ['synced', 'visit'],
      visit_id: visit.id,
      visit_status: normalizeText(visit.status) || null,
      file_url: null,
      continuity_url: buildContinuityUrl(growthLinks.facilityFinderUrl, visit.id),
      patient_app_deep_link: growthLinks.patientAppDeepLink,
    });
    visitSummaryCount += 1;

    const referralData = asObject(visit.referral_json);
    if (isVisitReferral(visit, referralData)) {
      const urgency = normalizeText(referralData?.urgency);
      records.push({
        id: `synced-referral-${visit.id}`,
        source: 'link_visit',
        synced: true,
        document_type: 'referral_summary',
        record_kind: 'referral_summary',
        document_date: toDateOnly(visit.visit_date || visit.created_at),
        provider_name: normalizeText(visit.provider) || null,
        description: buildReferralDescription(visit, referralData),
        tags: ['synced', 'referral', ...(urgency ? [urgency.toLowerCase()] : [])],
        visit_id: visit.id,
        visit_status: normalizeText(visit.status) || null,
        file_url: null,
        continuity_url: buildContinuityUrl(growthLinks.facilityFinderUrl, visit.id),
        patient_app_deep_link: growthLinks.patientAppDeepLink,
      });
      referralSummaryCount += 1;
    }
  }

  for (const order of medicationOrders || []) {
    const visit = visitMap.get(order.visit_id);
    records.push({
      id: `synced-rx-${order.id}`,
      source: 'link_visit',
      synced: true,
      document_type: 'prescription',
      record_kind: 'prescription',
      document_date: toDateOnly(order.dispensed_at || order.ordered_at || visit?.visit_date),
      provider_name: normalizeText(visit?.provider) || null,
      description: buildPrescriptionDescription(order),
      tags: ['synced', 'prescription', normalizeText(order.status).toLowerCase()].filter(Boolean),
      visit_id: order.visit_id,
      visit_status: normalizeText(visit?.status) || null,
      file_url: null,
      continuity_url: buildContinuityUrl(growthLinks.facilityFinderUrl, order.visit_id),
      patient_app_deep_link: growthLinks.patientAppDeepLink,
    });
    prescriptionCount += 1;
  }

  for (const order of labOrders || []) {
    const hasResultValue = Boolean(normalizeText(order.result_value) || normalizeText(order.result));
    const isCompleted = normalizeText(order.status).toLowerCase() === 'completed';
    if (!hasResultValue && !isCompleted) continue;

    const visit = visitMap.get(order.visit_id);
    records.push({
      id: `synced-lab-${order.id}`,
      source: 'link_visit',
      synced: true,
      document_type: 'lab_result',
      record_kind: 'lab_result',
      document_date: toDateOnly(order.completed_at || order.ordered_at || visit?.visit_date),
      provider_name: normalizeText(visit?.provider) || null,
      description: buildLabDescription(order),
      tags: ['synced', 'lab', normalizeText(order.status).toLowerCase()].filter(Boolean),
      visit_id: order.visit_id,
      visit_status: normalizeText(visit?.status) || null,
      file_url: null,
      continuity_url: buildContinuityUrl(growthLinks.facilityFinderUrl, order.visit_id),
      patient_app_deep_link: growthLinks.patientAppDeepLink,
    });
    labResultCount += 1;
  }

  records.sort((a, b) => {
    const priorityDiff = (recordPriority[a.record_kind] || 99) - (recordPriority[b.record_kind] || 99);
    if (priorityDiff !== 0) return priorityDiff;
    return b.document_date.localeCompare(a.document_date);
  });

  const limited = records.slice(0, maxRecords);

  return {
    records: limited,
    counts: {
      visitSummaries: visitSummaryCount,
      prescriptions: prescriptionCount,
      labResults: labResultCount,
      referralSummaries: referralSummaryCount,
    },
    growth: growthLinks,
  };
};
