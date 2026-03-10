import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type HistorySafetyInput = {
  chiefComplaint: string;
  triageReason: string;
  duration: string;
  associatedSymptomsCount: number;
  allergies: string;
  medications: string;
  diagnosisPresent: boolean;
  ageYears: number;
  gender: string;
  pregnancyFlag: boolean;
  visitNotesText: string;
  observationsText: string;
  nextStepsText: string;
  followUp: string;
  smoking: string;
  alcohol: string;
  familyHistory: string;
  rosStates: Array<{ checked: boolean; findings: string }>;
  weight: number;
  bloodPressure: string;
  triageUrgency: string;
  triageTriggers: string[];
  oxygenSaturation: number;
  emergencyExceptionEnabled: boolean;
  emergencyReason: string;
  emergencyAction: string;
};

const { evaluateHistorySafety } = require('../../../../src/components/doctor/historySafety') as {
  evaluateHistorySafety: (
    input: HistorySafetyInput,
    action: 'save' | 'route' | 'admit' | 'discharge' | 'complete'
  ) => {
    hardStops: Array<{ id: string }>;
    emergency: { canBypass: boolean };
  };
};

const doctorDashboardPath = path.resolve(__dirname, '../../../../src/components/DoctorDashboard.tsx');
const structuredClinicalAssessmentPath = path.resolve(
  __dirname,
  '../../../../src/components/StructuredClinicalAssessment.tsx'
);
const doctorApiPath = path.resolve(__dirname, '../../../../src/services/api/doctorApi.ts');
const doctorRoutePath = path.resolve(__dirname, '../doctor.ts');
const doctorHistoryServicePath = path.resolve(__dirname, '../../services/doctorVisitHistoryService.ts');
const patientVisitStatusServicePath = path.resolve(__dirname, '../../services/patientVisitStatusService.ts');

const read = (filePath: string) => fs.readFileSync(filePath, 'utf8');

const createSafeInput = (overrides: Partial<HistorySafetyInput> = {}): HistorySafetyInput => ({
  chiefComplaint: 'Cough',
  triageReason: '',
  duration: '2 days',
  associatedSymptomsCount: 2,
  allergies: 'NKDA',
  medications: 'None',
  diagnosisPresent: true,
  ageYears: 32,
  gender: 'male',
  pregnancyFlag: false,
  visitNotesText: 'Stable patient',
  observationsText: 'No red flags noted',
  nextStepsText: 'Review in 1 week',
  followUp: '1 week',
  smoking: 'never',
  alcohol: 'never',
  familyHistory: 'none',
  rosStates: [{ checked: true, findings: 'dry cough' }],
  weight: 65,
  bloodPressure: '120/80',
  triageUrgency: 'routine',
  triageTriggers: [],
  oxygenSaturation: 98,
  emergencyExceptionEnabled: false,
  emergencyReason: '',
  emergencyAction: '',
  ...overrides,
});

const extractBlock = (source: string, startMarker: string, endMarker: string) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);

  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);

  return source.slice(start, end);
};

test('W2-QA-DOCHIST-001 required minimal fields are enforced by hard-stop rules', () => {
  const validResult = evaluateHistorySafety(createSafeInput(), 'route');
  const validHardStopIds = new Set(validResult.hardStops.map((issue) => issue.id));

  assert.equal(validHardStopIds.has('HS-001'), false);
  assert.equal(validHardStopIds.has('HS-002'), false);
  assert.equal(validHardStopIds.has('HS-003'), false);
  assert.equal(validHardStopIds.has('HS-004'), false);
  assert.equal(validHardStopIds.has('HS-005'), false);

  const missingResult = evaluateHistorySafety(
    createSafeInput({
      chiefComplaint: '',
      triageReason: '',
      duration: '',
      associatedSymptomsCount: 0,
      allergies: '',
      medications: '',
    }),
    'route'
  );
  const missingHardStopIds = new Set(missingResult.hardStops.map((issue) => issue.id));

  assert.equal(missingHardStopIds.has('HS-001'), true);
  assert.equal(missingHardStopIds.has('HS-002'), true);
  assert.equal(missingHardStopIds.has('HS-003'), true);
  assert.equal(missingHardStopIds.has('HS-004'), true);
  assert.equal(missingHardStopIds.has('HS-005'), true);
});

test('W2-QA-DOCHIST-002 completion/admission requires diagnosis and cohort-specific minimums', () => {
  const diagnosisMissing = evaluateHistorySafety(
    createSafeInput({
      diagnosisPresent: false,
    }),
    'complete'
  );
  assert.ok(diagnosisMissing.hardStops.some((issue) => issue.id === 'HS-006'));

  const pediatricMissingWeight = evaluateHistorySafety(
    createSafeInput({
      ageYears: 7,
      gender: 'male',
      weight: 0,
      followUp: '',
      nextStepsText: '',
    }),
    'complete'
  );
  assert.ok(pediatricMissingWeight.hardStops.some((issue) => issue.id === 'HS-007'));

  const maternalMissingRequired = evaluateHistorySafety(
    createSafeInput({
      ageYears: 28,
      gender: 'female',
      pregnancyFlag: true,
      bloodPressure: '',
      observationsText: 'Patient reviewed today.',
      nextStepsText: 'Follow-up in obstetric clinic.',
    }),
    'admit'
  );
  assert.ok(maternalMissingRequired.hardStops.some((issue) => issue.id === 'HS-008'));
  assert.ok(maternalMissingRequired.hardStops.some((issue) => issue.id === 'HS-009'));
});

test('W2-QA-DOCHIST-003 emergency exception behavior is deterministic and bounded', () => {
  const validBypass = evaluateHistorySafety(
    createSafeInput({
      chiefComplaint: '',
      triageReason: '',
      duration: '',
      associatedSymptomsCount: 0,
      allergies: '',
      medications: '',
      triageUrgency: 'critical',
      emergencyExceptionEnabled: true,
      emergencyReason: 'Immediate airway compromise requires urgent stabilization and transfer.',
      emergencyAction: 'Initiate oxygen, IV support, and transfer to high-acuity emergency handoff.',
    }),
    'admit'
  );

  assert.equal(validBypass.emergency.canBypass, true);
  assert.equal(validBypass.hardStops.some((issue) => issue.id === 'HS-001'), false);
  assert.equal(validBypass.hardStops.some((issue) => issue.id === 'HS-002'), false);
  assert.equal(validBypass.hardStops.some((issue) => issue.id === 'HS-003'), false);

  const invalidDocumentation = evaluateHistorySafety(
    createSafeInput({
      triageUrgency: 'critical',
      emergencyExceptionEnabled: true,
      emergencyReason: 'too short',
      emergencyAction: 'short',
    }),
    'admit'
  );
  assert.ok(invalidDocumentation.hardStops.some((issue) => issue.id === 'HS-010'));

  const noBypassOnComplete = evaluateHistorySafety(
    createSafeInput({
      chiefComplaint: '',
      triageReason: '',
      duration: '',
      associatedSymptomsCount: 0,
      allergies: '',
      medications: '',
      triageUrgency: 'critical',
      emergencyExceptionEnabled: true,
      emergencyReason: 'Immediate airway compromise requires urgent stabilization and transfer.',
      emergencyAction: 'Initiate oxygen, IV support, and transfer to high-acuity emergency handoff.',
    }),
    'complete'
  );

  assert.equal(noBypassOnComplete.emergency.canBypass, false);
  assert.ok(noBypassOnComplete.hardStops.some((issue) => issue.id === 'HS-001'));
  assert.ok(noBypassOnComplete.hardStops.some((issue) => issue.id === 'HS-002'));
  assert.ok(noBypassOnComplete.hardStops.some((issue) => issue.id === 'HS-003'));
});

test('W2-QA-DOCHIST-004 multi-complaint capture/edit/remove flow remains wired', () => {
  const source = read(structuredClinicalAssessmentPath);

  assert.match(source, /const handleOpenComplaintDialog = \(complaintName: string\) => \{/);
  assert.match(source, /const handleEditComplaint = \(index: number\) => \{/);
  assert.match(source, /const handleSaveComplaint = \(\) => \{/);
  assert.match(
    source,
    /setHpiData\(prev => \(\{[\s\S]*?chiefComplaints: \[\.\.\.prev\.chiefComplaints, currentComplaintData\][\s\S]*?\}\)\);/
  );
  assert.match(
    source,
    /chiefComplaints: prev\.chiefComplaints\.map\(cc =>[\s\S]*?\? currentComplaintData[\s\S]*?: cc/
  );
  assert.match(
    source,
    /const handleRemoveComplaint = \(index: number\) => \{[\s\S]*?chiefComplaints: prev\.chiefComplaints\.filter\(\(_, i\) => i !== index\)/
  );
});

test('W2-QA-DOCHIST-005 doctor history save API contract exists in FE and BE', () => {
  const doctorApiSource = read(doctorApiPath);
  const doctorRouteSource = read(doctorRoutePath);
  const doctorHistorySource = read(doctorHistoryServicePath);

  assert.match(doctorApiSource, /saveVisitHistory: async \(visitId: string, payload:[\s\S]*?\) =>/);
  assert.match(doctorApiSource, /export type DoctorVisitHistorySaveResponse = \{/);
  assert.match(doctorApiSource, /apiClient\.post<DoctorVisitHistorySaveResponse>\(`\/doctor\/visits\/\$\{visitId\}\/history`, payload\)/);
  assert.match(doctorRouteSource, /router\.post\('\/visits\/:id\/history', async \(req, res\) => \{/);
  assert.match(doctorRouteSource, /'VALIDATION_INVALID_DOCTOR_HISTORY_PAYLOAD'/);
  assert.match(doctorRouteSource, /sendContractError\(res, result\.status, result\.code, result\.message\)/);
  assert.match(doctorHistorySource, /export const saveDoctorVisitHistory = async \(\{/);
});

test('W2-QA-DOCHIST-006 doctor history route exposes stable validation codes FE can branch on', () => {
  const doctorRouteSource = read(doctorRoutePath);
  const doctorHistorySource = read(doctorHistoryServicePath);

  assert.match(doctorRouteSource, /VALIDATION_INVALID_VISIT_ID/);
  assert.match(doctorRouteSource, /VALIDATION_INVALID_DOCTOR_HISTORY_PAYLOAD/);

  assert.match(doctorHistorySource, /VALIDATION_DH_HS_001_MISSING_CHIEF_COMPLAINT/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_002_MISSING_HPI_DURATION/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_003_MISSING_ASSOCIATED_SYMPTOM/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_004_MISSING_ALLERGY_STATUS/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_005_MISSING_MEDICATION_HISTORY/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_006_DIAGNOSIS_REQUIRED_FOR_CLOSURE/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_007_PEDIATRIC_WEIGHT_REQUIRED/);
  assert.match(doctorHistorySource, /VALIDATION_DH_PEDIATRIC_FOLLOW_UP_REQUIRED/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_008_MATERNAL_BP_REQUIRED/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_009_MATERNAL_OBSTETRIC_CONTEXT_REQUIRED/);
  assert.match(doctorHistorySource, /VALIDATION_DH_HS_010_EMERGENCY_OVERRIDE_REQUIRED/);
  assert.match(doctorHistorySource, /VALIDATION_DH_SW_004_FOLLOW_UP_REQUIRED_FOR_COMPLETION/);
  assert.match(doctorHistorySource, /VALIDATION_DH_SW_005_PENDING_ORDERS_ACK_REQUIRED/);
  assert.match(doctorHistorySource, /WARNING_DH_SW_001_ROS_EMPTY/);
  assert.match(doctorHistorySource, /WARNING_DH_SW_002_FAMILY_HISTORY_EMPTY/);
  assert.match(doctorHistorySource, /WARNING_DH_SW_003_SOCIAL_HISTORY_INCOMPLETE/);
  assert.match(doctorHistorySource, /WARNING_DH_SW_004_FOLLOW_UP_MISSING/);
  assert.match(doctorHistorySource, /WARNING_DH_SW_005_OUTSTANDING_ORDERS/);
  assert.match(doctorHistorySource, /warnings:\s*DoctorVisitHistoryWarning\[\]/);
  assert.match(doctorHistorySource, /VALIDATION_DH_MATERNAL_DANGER_SIGN_SCREEN_REQUIRED/);
  assert.match(doctorHistorySource, /PERM_VISIT_HISTORY_SAVE_FORBIDDEN/);
  assert.match(doctorHistorySource, /TENANT_RESOURCE_SCOPE_VIOLATION/);
  assert.match(doctorHistorySource, /CONFLICT_AUDIT_DURABILITY_FAILURE/);
});

test('W2-QA-DOCHIST-007 cross-layer gate remains active for code/message response contract', () => {
  const doctorApiSource = read(doctorApiPath);
  const doctorRouteSource = read(doctorRoutePath);

  assert.match(doctorApiSource, /saveVisitHistory: async \(visitId: string, payload:[\s\S]*?\) =>/);
  assert.match(doctorApiSource, /`\/doctor\/visits\/\$\{visitId\}\/history`/);
  assert.match(doctorRouteSource, /const sendContractError = \(res: any, status: number, code: string, message: string\) =>/);
  assert.match(doctorRouteSource, /res\.status\(status\)\.json\(\{ code, message \}\)/);
});

test('W2-QA-DOCHIST-008 visit progression guardrails remain enforced after save', () => {
  const dashboardSource = read(doctorDashboardPath);
  const statusServiceSource = read(patientVisitStatusServicePath);

  const completeConsultBlock = extractBlock(
    dashboardSource,
    'const handleCompleteConsultation = async () => {',
    'const handleAdmitPatient = async () => {'
  );

  assert.match(completeConsultBlock, /await handleSaveClinicalNotes\(\);/);
  assert.match(dashboardSource, /await doctorApi\.updateVisitStatus\(selectedPatient\.id, \{[\s\S]*?status: 'admitted'/);

  assert.match(statusServiceSource, /const transitionGuardMap: Record<string, Set<string>> = \{/);
  assert.match(statusServiceSource, /'CONFLICT_INVALID_VISIT_STATUS_TRANSITION'/);
  assert.match(statusServiceSource, /const terminalStatuses = new Set\(\['discharged'\]\)/);
  assert.match(statusServiceSource, /'CONFLICT_TERMINAL_VISIT_STATUS'/);
});
