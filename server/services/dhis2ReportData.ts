import { supabaseAdmin } from '../config/supabase';

const VISIT_SELECT =
  'id, patient_id, visit_date, reason, clinical_notes, admitted_at, blood_pressure, patients(age)';

const RELATED_TABLE_SELECTS = {
  anc_assessments: 'visit_id, patient_id, anc_visit_number, iptp_given',
  delivery_records:
    'visit_id, patient_id, delivery_datetime, birth_attendant, delivery_complications, blood_loss_ml, birth_outcome, birth_weight',
  lab_orders: 'visit_id, patient_id, test_name, result, result_value',
  medication_orders: 'visit_id, patient_id, medication_name, status, dispensed_at, notes',
  pediatric_assessments:
    'visit_id, patient_id, notes, edema_grading, malnutrition_classification, malaria_positive',
  immunization_records: 'visit_id, patient_id, bcg_date, penta3_date, mcv1_date',
} as const;

const SUPPORTED_PROGRAMS = ['RMNCH', 'EPI', 'HIV', 'TB', 'NUT', 'NCD', 'MALARIA'] as const;

type SupportedProgram = (typeof SUPPORTED_PROGRAMS)[number];
type ReportProgram = SupportedProgram | 'ALL';

type VisitRow = {
  id: string;
  patient_id?: string | null;
  visit_date?: string | null;
  reason?: string | null;
  clinical_notes?: string | null;
  admitted_at?: string | null;
  blood_pressure?: string | null;
  patients?: { age?: number | null } | Array<{ age?: number | null }> | null;
};

type AncAssessmentRow = {
  visit_id?: string | null;
  patient_id?: string | null;
  anc_visit_number?: number | string | null;
  iptp_given?: boolean | null;
};

type DeliveryRecordRow = {
  visit_id?: string | null;
  patient_id?: string | null;
  delivery_datetime?: string | null;
  birth_attendant?: string | null;
  delivery_complications?: string[] | string | null;
  blood_loss_ml?: number | string | null;
  birth_outcome?: string | null;
  birth_weight?: number | string | null;
};

type LabOrderRow = {
  visit_id?: string | null;
  patient_id?: string | null;
  test_name?: string | null;
  result?: string | null;
  result_value?: string | null;
};

type MedicationOrderRow = {
  visit_id?: string | null;
  patient_id?: string | null;
  medication_name?: string | null;
  status?: string | null;
  dispensed_at?: string | null;
  notes?: string | null;
};

type PediatricAssessmentRow = {
  visit_id?: string | null;
  patient_id?: string | null;
  notes?: string | null;
  edema_grading?: string | null;
  malnutrition_classification?: string | null;
  malaria_positive?: boolean | null;
};

type ImmunizationRecordRow = {
  visit_id?: string | null;
  patient_id?: string | null;
  bcg_date?: string | null;
  penta3_date?: string | null;
  mcv1_date?: string | null;
};

type ReportBundle = {
  visits: VisitRow[];
  ancAssessments: AncAssessmentRow[];
  deliveryRecords: DeliveryRecordRow[];
  labOrders: LabOrderRow[];
  medicationOrders: MedicationOrderRow[];
  pediatricAssessments: PediatricAssessmentRow[];
  immunizationRecords: ImmunizationRecordRow[];
};

type ReportDataResult = {
  program: ReportProgram;
  values: Record<string, number>;
  departmentTallies: Record<string, number>;
  sourceCounts: {
    visits: number;
    ancAssessments: number;
    deliveryRecords: number;
    labOrders: number;
    medicationOrders: number;
    pediatricAssessments: number;
    immunizationRecords: number;
  };
};

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const selectAllRows = async <T>(
  buildQuery: (
    offset: number,
    size: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
  size = 500
) => {
  const rows: T[] = [];
  for (let offset = 0; ; offset += size) {
    const { data, error } = await buildQuery(offset, size);
    if (error) {
      throw new Error(`${label}: ${error.message}`);
    }
    rows.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return rows;
};

const selectByIds = async <T, TTable extends keyof typeof RELATED_TABLE_SELECTS>(
  table: TTable,
  ids: string[],
  label: string,
  size = 200
) => {
  if (!ids.length) return [] as T[];

  const rows: T[] = [];
  for (const batch of chunk(ids, size)) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(RELATED_TABLE_SELECTS[table])
      .in('visit_id', batch);

    if (error) {
      throw new Error(`${label}: ${error.message}`);
    }
    rows.push(...((data || []) as T[]));
  }
  return rows;
};

const toLower = (value: unknown) => String(value || '').toLowerCase();
const trimDashes = (value: unknown) => String(value || '').replace(/-/g, '');
const toArray = (value: unknown) => (Array.isArray(value) ? value : []);
const uniqueCount = (values: Array<string | null | undefined>) => new Set(values.filter(Boolean)).size;
const normaliseTerms = (value: unknown) =>
  ` ${toLower(value).replace(/[^a-z0-9]+/g, ' ').trim()} `;

const textIncludesAny = (value: unknown, needles: string[]) => {
  const lower = toLower(value);
  return needles.some((needle) => lower.includes(needle));
};

const textHasAnyTerm = (value: unknown, needles: string[]) => {
  const normalised = normaliseTerms(value);
  return needles.some((needle) => normalised.includes(normaliseTerms(needle)));
};

const arrayIncludesAny = (value: unknown, needles: string[]) => {
  const entries = toArray(value).map((item) => toLower(item));
  return needles.some((needle) => entries.some((entry) => entry.includes(needle)));
};

const parseNumeric = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
};

const isSameOrBefore = (left: unknown, right: unknown) =>
  new Date(String(left || '')).getTime() <= new Date(String(right || '')).getTime();
const diffDays = (left: unknown, right: unknown) =>
  Math.round(
    (new Date(String(right || '')).getTime() - new Date(String(left || '')).getTime()) /
      (24 * 60 * 60 * 1000)
  );

const isHivTestOrder = (order: LabOrderRow) =>
  textIncludesAny(order.test_name, ['hiv rapid', 'hiv test', 'hiv screening', 'elisa']);

const isPositiveHivResult = (order: LabOrderRow) => {
  const combined = `${order.result || ''} ${order.result_value || ''}`;
  if (textHasAnyTerm(combined, ['negative', 'non-reactive', 'not reactive'])) {
    return false;
  }
  return textHasAnyTerm(combined, ['positive', 'reactive']);
};

const isViralLoadOrder = (order: LabOrderRow) =>
  textIncludesAny(order.test_name, ['viral load']);

const isSuppressedViralLoad = (order: LabOrderRow) => {
  const numeric = parseNumeric(order.result_value);
  if (numeric !== null) return numeric < 1000;
  const combined = `${order.result || ''} ${order.result_value || ''}`;
  if (textHasAnyTerm(combined, ['unsuppressed', 'not suppressed', 'high viral load'])) {
    return false;
  }
  return textHasAnyTerm(combined, ['suppressed', 'undetectable', 'target not detected']);
};

const isArtMedication = (order: MedicationOrderRow) =>
  textIncludesAny(order.medication_name, [
    'tenofovir',
    'lamivudine',
    'dolutegravir',
    'tld',
    'efavirenz',
    'abacavir',
  ]);

const isTbPositiveLab = (order: LabOrderRow) =>
  textIncludesAny(order.test_name, ['genexpert', 'xpert', 'sputum', 'afb', 'tb']) &&
  !textHasAnyTerm(`${order.result || ''} ${order.result_value || ''}`, ['negative', 'not detected']) &&
  textHasAnyTerm(`${order.result || ''} ${order.result_value || ''}`, ['mtb detected', 'detected', 'positive', 'ptb']);

const isDrugResistantTb = (value: unknown) =>
  textIncludesAny(value, ['rifampicin resistant', 'drug-resistant', 'mdr', 'xdr', 'rr-tb']);

const isMalariaTestOrder = (order: LabOrderRow) =>
  textIncludesAny(order.test_name, ['malaria', 'rdt']);

const isPositiveMalariaResult = (order: LabOrderRow) =>
  !textHasAnyTerm(`${order.result || ''} ${order.result_value || ''}`, [
    'negative',
    'not seen',
    'not detected',
  ]) &&
  textIncludesAny(`${order.result || ''} ${order.result_value || ''}`, [
    'positive',
    'plasmodium',
    'falciparum',
    'vivax',
  ]);

const isMalariaTreatment = (order: MedicationOrderRow) =>
  textIncludesAny(order.medication_name, [
    'coartem',
    'artemether',
    'lumefantrine',
    'artesunate',
    'quinine',
  ]);

const countDepartment = (departmentTallies: Record<string, number>, key: string, increment = 1) => {
  departmentTallies[key] = (departmentTallies[key] || 0) + increment;
};

const getPatientAgeFromVisit = (visit: VisitRow) => {
  const patientRecord = Array.isArray(visit?.patients) ? visit.patients[0] : visit?.patients;
  const age = Number(patientRecord?.age);
  return Number.isFinite(age) ? age : null;
};

const computeRmncIndicators = (bundle: ReportBundle) => {
  const values: Record<string, number> = {};
  const departmentTallies: Record<string, number> = {};
  const ancAssessments = bundle.ancAssessments || [];
  const deliveryRecords = bundle.deliveryRecords || [];
  const visits = bundle.visits || [];
  const medicationOrders = bundle.medicationOrders || [];

  values.ANC1 = ancAssessments.filter((item) => Number(item.anc_visit_number || 0) === 1).length;

  const highestAncVisitByPatient = new Map<string, number>();
  for (const assessment of ancAssessments) {
    if (!assessment.patient_id) continue;
    const current = highestAncVisitByPatient.get(assessment.patient_id) || 0;
    highestAncVisitByPatient.set(
      assessment.patient_id,
      Math.max(current, Number(assessment.anc_visit_number || 0))
    );
  }
  values.ANC4 = Array.from(highestAncVisitByPatient.values()).filter((visitNo) => visitNo >= 4).length;
  values.SBA = deliveryRecords.filter(
    (item) => item.birth_attendant && toLower(item.birth_attendant) !== 'none'
  ).length;
  values.PPH = deliveryRecords.filter(
    (item) =>
      arrayIncludesAny(item.delivery_complications, ['postpartum_hemorrhage']) ||
      Number(item.blood_loss_ml || 0) >= 500
  ).length;
  values.STILL = deliveryRecords.filter((item) => textIncludesAny(item.birth_outcome, ['still'])).length;

  const deliveryDatesByPatient = new Map<string, string[]>();
  for (const delivery of deliveryRecords) {
    if (!delivery.patient_id || !delivery.delivery_datetime) continue;
    const entries = deliveryDatesByPatient.get(delivery.patient_id) || [];
    entries.push(delivery.delivery_datetime);
    deliveryDatesByPatient.set(delivery.patient_id, entries);
  }

  values.PNC7D = visits.filter((visit) => {
    if (!visit.patient_id) return false;
    if (!textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, ['postnatal', 'pnc'])) {
      return false;
    }
    const deliveryDates = deliveryDatesByPatient.get(visit.patient_id) || [];
    return deliveryDates.some(
      (deliveryDate) =>
        isSameOrBefore(deliveryDate, visit.visit_date) && diffDays(deliveryDate, visit.visit_date) <= 7
    );
  }).length;

  values.FP_NEW = visits.filter((visit) =>
    textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, [
      'family planning',
      'new acceptor',
      'fp new',
    ])
  ).length;

  countDepartment(
    departmentTallies,
    'MCH',
    ancAssessments.length + deliveryRecords.length + values.PNC7D + values.FP_NEW
  );
  countDepartment(
    departmentTallies,
    'Pharmacy',
    medicationOrders.filter((order) =>
      textIncludesAny(order.medication_name, ['ferrous', 'folic', 'depo', 'implant'])
    ).length
  );

  return { values, departmentTallies };
};

const computeHivIndicators = (bundle: ReportBundle) => {
  const values: Record<string, number> = {};
  const departmentTallies: Record<string, number> = {};
  const visits = bundle.visits || [];
  const labOrders = bundle.labOrders || [];
  const medicationOrders = bundle.medicationOrders || [];

  const htsOrders = labOrders.filter((order) => isHivTestOrder(order));
  const positiveOrders = htsOrders.filter((order) => isPositiveHivResult(order));
  const viralLoadOrders = labOrders.filter((order) => isViralLoadOrder(order));
  const artOrders = medicationOrders.filter((order) => isArtMedication(order));
  const txNewVisits = visits.filter((visit) =>
    textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, [
      'art initiation',
      'new on art',
      'start art',
    ])
  );

  values.HTS = htsOrders.length;
  values.HTS_POS = positiveOrders.length;
  values.TX_NEW = uniqueCount(txNewVisits.map((visit) => visit.patient_id));
  values.TX_CURR = uniqueCount(
    artOrders
      .filter(
        (order) =>
          textIncludesAny(order.status, ['dispensed', 'completed', 'active', 'pending']) ||
          Boolean(order.dispensed_at)
      )
      .map((order) => order.patient_id)
  );
  values.VL_TESTED = viralLoadOrders.length;
  values.VL_SUPP = viralLoadOrders.filter((order) => isSuppressedViralLoad(order)).length;

  countDepartment(departmentTallies, 'OPD', txNewVisits.length);
  countDepartment(departmentTallies, 'Laboratory', htsOrders.length + viralLoadOrders.length);
  countDepartment(departmentTallies, 'Pharmacy', artOrders.length);

  return { values, departmentTallies };
};

const computeEpiIndicators = (bundle: ReportBundle) => {
  const values: Record<string, number> = {};
  const departmentTallies: Record<string, number> = {};
  const immunizationRecords = bundle.immunizationRecords || [];

  values.BCG = immunizationRecords.filter((item) => item.bcg_date).length;
  values.PENTA3 = immunizationRecords.filter((item) => item.penta3_date).length;
  values.MCV1 = immunizationRecords.filter((item) => item.mcv1_date).length;
  values.FI1 = uniqueCount(
    immunizationRecords
      .filter((item) => item.bcg_date && item.penta3_date && item.mcv1_date)
      .map((item) => item.patient_id)
  );
  values.DOSES_GIVEN = immunizationRecords.reduce((sum, item) => {
    let doses = 0;
    if (item.bcg_date) doses += 1;
    if (item.penta3_date) doses += 1;
    if (item.mcv1_date) doses += 1;
    return sum + doses;
  }, 0);
  values.VIALS_OPEN = Math.ceil((values.DOSES_GIVEN || 0) / 10);

  countDepartment(departmentTallies, 'MCH', immunizationRecords.length);

  return { values, departmentTallies };
};

const computeTbIndicators = (bundle: ReportBundle) => {
  const values: Record<string, number> = {};
  const departmentTallies: Record<string, number> = {};
  const visits = bundle.visits || [];
  const labOrders = bundle.labOrders || [];
  const medicationOrders = bundle.medicationOrders || [];

  const confirmedTbVisits = visits.filter((visit) =>
    textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, [
      'confirmed tb',
      'pulmonary tb',
      'ptb+',
      'eptb',
      'drug-resistant tb',
      'rifampicin resistant',
    ])
  );
  const ptbPositivePatients = new Set(
    labOrders.filter((order) => isTbPositiveLab(order)).map((order) => order.patient_id).filter(Boolean)
  );
  const eptbPatients = new Set(
    visits
      .filter((visit) =>
        textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, ['eptb', 'extra pulmonary'])
      )
      .map((visit) => visit.patient_id)
      .filter(Boolean)
  );
  const drTbPatients = new Set(
    visits
      .filter((visit) => isDrugResistantTb(`${visit.reason || ''} ${visit.clinical_notes || ''}`))
      .map((visit) => visit.patient_id)
      .filter(Boolean)
      .concat(
        labOrders
          .filter((order) => isDrugResistantTb(order.result))
          .map((order) => order.patient_id)
          .filter(Boolean)
      )
  );
  const tptStartPatients = new Set(
    medicationOrders
      .filter((order) =>
        textIncludesAny(`${order.notes || ''} ${order.medication_name || ''}`, [
          'tpt start',
          'isoniazid preventive',
        ])
      )
      .map((order) => order.patient_id)
      .filter(Boolean)
      .concat(
        visits
          .filter((visit) => textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, ['tpt start']))
          .map((visit) => visit.patient_id)
          .filter(Boolean)
      )
  );
  const tptCompletePatients = new Set(
    medicationOrders
      .filter((order) => textIncludesAny(`${order.notes || ''} ${order.medication_name || ''}`, ['tpt completed']))
      .map((order) => order.patient_id)
      .filter(Boolean)
      .concat(
        visits
          .filter((visit) =>
            textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, ['tpt completed'])
          )
          .map((visit) => visit.patient_id)
          .filter(Boolean)
      )
  );

  values.TB_ALL = uniqueCount(confirmedTbVisits.map((visit) => visit.patient_id));
  values.PTB_POS = ptbPositivePatients.size;
  values.EPTB = eptbPatients.size;
  values.DRTB = drTbPatients.size;
  values.TPT_START = tptStartPatients.size;
  values.TPT_COMP = tptCompletePatients.size;

  countDepartment(departmentTallies, 'OPD', confirmedTbVisits.length);
  countDepartment(
    departmentTallies,
    'Laboratory',
    labOrders.filter((order) => textIncludesAny(order.test_name, ['tb', 'xpert', 'sputum', 'afb'])).length
  );
  countDepartment(
    departmentTallies,
    'Pharmacy',
    medicationOrders.filter((order) =>
      textIncludesAny(`${order.medication_name || ''} ${order.notes || ''}`, [
        'rifampicin',
        'isoniazid',
        'ethambutol',
        'pyrazinamide',
        'tpt',
      ])
    ).length
  );

  return { values, departmentTallies };
};

const computeMalariaIndicators = (bundle: ReportBundle) => {
  const values: Record<string, number> = {};
  const departmentTallies: Record<string, number> = {};
  const visits = bundle.visits || [];
  const labOrders = bundle.labOrders || [];
  const ancAssessments = bundle.ancAssessments || [];
  const medicationOrders = bundle.medicationOrders || [];
  const pediatricAssessments = bundle.pediatricAssessments || [];

  const malariaTests = labOrders.filter((order) => isMalariaTestOrder(order));
  const malariaPositive = malariaTests.filter((order) => isPositiveMalariaResult(order));
  const severeMalariaVisits = visits.filter((visit) =>
    textHasAnyTerm(`${visit.reason || ''} ${visit.clinical_notes || ''}`, [
      'severe malaria',
      'complicated malaria',
    ]) ||
    (visit.admitted_at && textHasAnyTerm(`${visit.reason || ''} ${visit.clinical_notes || ''}`, ['malaria']))
  );

  const iptpCountsByPatient = new Map<string, number>();
  for (const assessment of ancAssessments) {
    if (!assessment.patient_id || !assessment.iptp_given) continue;
    iptpCountsByPatient.set(
      assessment.patient_id,
      (iptpCountsByPatient.get(assessment.patient_id) || 0) + 1
    );
  }

  values.MAL_TESTS = malariaTests.length;
  values.MAL_POS = uniqueCount(
    malariaPositive
      .map((order) => order.patient_id)
      .filter(Boolean)
      .concat(
        pediatricAssessments
          .filter((assessment) => assessment.malaria_positive)
          .map((assessment) => assessment.patient_id)
          .filter(Boolean)
      )
  );
  values.MAL_TX = uniqueCount(
    medicationOrders
      .filter((order) => isMalariaTreatment(order))
      .map((order) => order.patient_id)
      .filter(Boolean)
  );
  values.MAL_SEV = uniqueCount(severeMalariaVisits.map((visit) => visit.patient_id));
  values.IPTP2P = Array.from(iptpCountsByPatient.values()).filter((count) => count >= 2).length;

  countDepartment(departmentTallies, 'OPD', severeMalariaVisits.length);
  countDepartment(departmentTallies, 'Laboratory', malariaTests.length);
  countDepartment(
    departmentTallies,
    'Pharmacy',
    medicationOrders.filter((order) => isMalariaTreatment(order)).length
  );
  countDepartment(
    departmentTallies,
    'MCH',
    ancAssessments.filter((assessment) => Boolean(assessment.iptp_given)).length
  );

  return { values, departmentTallies };
};

const computeNutritionIndicators = (bundle: ReportBundle) => {
  const values: Record<string, number> = {};
  const departmentTallies: Record<string, number> = {};
  const visits = bundle.visits || [];
  const deliveryRecords = bundle.deliveryRecords || [];
  const pediatricAssessments = bundle.pediatricAssessments || [];
  const patientAgeYearsById = new Map<string, number>();

  for (const visit of visits) {
    if (!visit.patient_id) continue;
    const age = getPatientAgeFromVisit(visit);
    if (age === null || patientAgeYearsById.has(visit.patient_id)) continue;
    patientAgeYearsById.set(visit.patient_id, age);
  }

  values.LBW = deliveryRecords.filter((record) => {
    const weight = Number(record.birth_weight || 0);
    return weight > 0 && weight < 2.5;
  }).length;
  values.VITA = visits.filter((visit) =>
    textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, ['vitamin a', 'vita'])
  ).length;
  values.GMP_U2 = pediatricAssessments.filter((item) => {
    const patientAgeYears = item.patient_id ? patientAgeYearsById.get(item.patient_id) : null;
    return (typeof patientAgeYears === 'number' && patientAgeYears < 2) || textIncludesAny(item.notes, ['growth monitoring']);
  }).length;
  values.SAM_ADM = pediatricAssessments.filter(
    (item) =>
      textIncludesAny(item.edema_grading, ['severe', '+++', '++']) ||
      textIncludesAny(item.malnutrition_classification, ['sam', 'severe'])
  ).length;
  values.SAM_CURE = pediatricAssessments.filter((item) =>
    textIncludesAny(item.notes, ['sam cured', 'otp cured', 'cured'])
  ).length;

  countDepartment(departmentTallies, 'Pediatrics', pediatricAssessments.length);
  countDepartment(departmentTallies, 'MCH', deliveryRecords.length);

  return { values, departmentTallies };
};

const computeNcdIndicators = (bundle: ReportBundle) => {
  const values: Record<string, number> = {};
  const departmentTallies: Record<string, number> = {};
  const visits = bundle.visits || [];
  const labOrders = bundle.labOrders || [];

  const hypertensionVisits = visits.filter((visit) =>
    textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, ['hypertension', 'htn'])
  );
  const diabetesVisits = visits.filter((visit) =>
    textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, ['diabetes', 'dm screening', 'blood sugar'])
  );

  values.HTN_SCR = visits.filter((visit) => Boolean(visit.blood_pressure)).length;
  values.HTN_CTRL = hypertensionVisits.filter((visit) => {
    const parts = String(visit.blood_pressure || '')
      .split('/')
      .map((item) => Number(item));
    return parts.length === 2 && parts[0] < 140 && parts[1] < 90;
  }).length;
  values.DM_SCR =
    diabetesVisits.length +
    labOrders.filter((order) => textIncludesAny(order.test_name, ['blood sugar', 'glucose', 'hba1c'])).length;
  values.DM_CTRL = diabetesVisits.filter((visit) =>
    textIncludesAny(visit.clinical_notes, ['diabetes controlled', 'sugar controlled'])
  ).length;
  values.CVD_HIGH = visits.filter((visit) =>
    textIncludesAny(`${visit.reason || ''} ${visit.clinical_notes || ''}`, [
      'high cvd risk',
      'stroke risk',
      'cvd risk',
    ])
  ).length;

  countDepartment(departmentTallies, 'OPD', hypertensionVisits.length + diabetesVisits.length);
  countDepartment(
    departmentTallies,
    'Laboratory',
    labOrders.filter((order) => textIncludesAny(order.test_name, ['blood sugar', 'glucose', 'hba1c'])).length
  );

  return { values, departmentTallies };
};

const calculateProgramIndicators = (program: SupportedProgram, bundle: ReportBundle) => {
  if (program === 'RMNCH') return computeRmncIndicators(bundle);
  if (program === 'EPI') return computeEpiIndicators(bundle);
  if (program === 'HIV') return computeHivIndicators(bundle);
  if (program === 'TB') return computeTbIndicators(bundle);
  if (program === 'NUT') return computeNutritionIndicators(bundle);
  if (program === 'NCD') return computeNcdIndicators(bundle);
  return computeMalariaIndicators(bundle);
};

const normalizeProgram = (program: string): ReportProgram => {
  const normalized = trimDashes(program).toUpperCase();
  if (normalized === 'ALL' || normalized === '__ALL_PROGRAMS__') return 'ALL';
  if (SUPPORTED_PROGRAMS.includes(normalized as SupportedProgram)) {
    return normalized as SupportedProgram;
  }
  throw new Error(`Unsupported DHIS2 program ${program}`);
};

const fetchFacilityReportBundle = async ({
  facilityId,
  from,
  to,
}: {
  facilityId: string;
  from: string;
  to: string;
}) => {
  const visits = await selectAllRows<VisitRow>(
    (offset, size) =>
      supabaseAdmin
        .from('visits')
        .select(VISIT_SELECT)
        .eq('facility_id', facilityId)
        .gte('visit_date', from)
        .lte('visit_date', to)
        .range(offset, offset + size - 1),
    'report visits lookup'
  );

  const visitIds = visits.map((visit) => visit.id).filter(Boolean);
  if (!visitIds.length) {
    return {
      visits: [],
      ancAssessments: [],
      deliveryRecords: [],
      labOrders: [],
      medicationOrders: [],
      pediatricAssessments: [],
      immunizationRecords: [],
    } satisfies ReportBundle;
  }

  const [ancAssessments, deliveryRecords, labOrders, medicationOrders, pediatricAssessments, immunizationRecords] =
    await Promise.all([
      selectByIds<AncAssessmentRow, 'anc_assessments'>('anc_assessments', visitIds, 'report anc'),
      selectByIds<DeliveryRecordRow, 'delivery_records'>('delivery_records', visitIds, 'report delivery'),
      selectByIds<LabOrderRow, 'lab_orders'>('lab_orders', visitIds, 'report lab'),
      selectByIds<MedicationOrderRow, 'medication_orders'>('medication_orders', visitIds, 'report meds'),
      selectByIds<PediatricAssessmentRow, 'pediatric_assessments'>(
        'pediatric_assessments',
        visitIds,
        'report pediatrics'
      ),
      selectByIds<ImmunizationRecordRow, 'immunization_records'>(
        'immunization_records',
        visitIds,
        'report immunization'
      ),
    ]);

  return {
    visits,
    ancAssessments,
    deliveryRecords,
    labOrders,
    medicationOrders,
    pediatricAssessments,
    immunizationRecords,
  } satisfies ReportBundle;
};

const mergeProgramReports = (bundle: ReportBundle) =>
  SUPPORTED_PROGRAMS.reduce(
    (aggregate, program) => {
      const result = calculateProgramIndicators(program, bundle);
      Object.assign(aggregate.values, result.values);
      Object.entries(result.departmentTallies).forEach(([department, count]) => {
        aggregate.departmentTallies[department] = (aggregate.departmentTallies[department] || 0) + count;
      });
      return aggregate;
    },
    { values: {} as Record<string, number>, departmentTallies: {} as Record<string, number> }
  );

export const buildFacilityDhis2ReportData = async ({
  facilityId,
  program,
  from,
  to,
}: {
  facilityId: string;
  program: string;
  from: string;
  to: string;
}): Promise<ReportDataResult> => {
  const normalizedProgram = normalizeProgram(program);
  const bundle = await fetchFacilityReportBundle({ facilityId, from, to });
  const calculated =
    normalizedProgram === 'ALL'
      ? mergeProgramReports(bundle)
      : calculateProgramIndicators(normalizedProgram, bundle);

  return {
    program: normalizedProgram,
    values: calculated.values,
    departmentTallies: calculated.departmentTallies,
    sourceCounts: {
      visits: bundle.visits.length,
      ancAssessments: bundle.ancAssessments.length,
      deliveryRecords: bundle.deliveryRecords.length,
      labOrders: bundle.labOrders.length,
      medicationOrders: bundle.medicationOrders.length,
      pediatricAssessments: bundle.pediatricAssessments.length,
      immunizationRecords: bundle.immunizationRecords.length,
    },
  };
};
