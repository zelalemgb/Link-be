import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';
import {
  doctorVisitHistorySaveSchema,
  saveDoctorVisitHistory,
} from '../services/doctorVisitHistoryService';
import { cdssEvaluateRequestSchema, evaluateCdss } from '../services/cdssService';

const router = Router();
router.use(requireUser, requireScopedUser);

const visitIdParamSchema = z.string().uuid();
const sendContractError = (res: any, status: number, code: string, message: string) =>
  res.status(status).json({ code, message });

const historyValidationOutcomeMap = {
  HS_001: {
    code: 'VALIDATION_DH_HS_001_MISSING_CHIEF_COMPLAINT',
    message: 'Chief complaint is required before you can continue.',
  },
  HS_002: {
    code: 'VALIDATION_DH_HS_002_MISSING_HPI_DURATION',
    message: 'History duration is required before you can continue.',
  },
  HS_003: {
    code: 'VALIDATION_DH_HS_003_MISSING_ASSOCIATED_SYMPTOM',
    message: 'At least one associated symptom is required.',
  },
  HS_004: {
    code: 'VALIDATION_DH_HS_004_MISSING_ALLERGY_STATUS',
    message: "Allergy status is required. Enter known allergies or 'None/NKDA'.",
  },
  HS_005: {
    code: 'VALIDATION_DH_HS_005_MISSING_MEDICATION_HISTORY',
    message: "Current medication history is required. Enter active medications or 'None'.",
  },
} as const;

const mapDoctorHistoryPayloadIssue = (issue: z.ZodIssue) => {
  const path = issue.path.map((segment) => String(segment)).join('.');

  if (
    path === 'chiefComplaints' ||
    path.endsWith('.chiefComplaints') ||
    path.endsWith('.complaint') ||
    path === 'chiefComplaints.0'
  ) {
    return historyValidationOutcomeMap.HS_001;
  }

  if (path.endsWith('.hpi.duration') || path === 'chiefComplaints.0.hpi') {
    return historyValidationOutcomeMap.HS_002;
  }

  if (path.includes('associatedSymptoms')) {
    return historyValidationOutcomeMap.HS_003;
  }

  if (path.endsWith('medicalHistory.allergies')) {
    return historyValidationOutcomeMap.HS_004;
  }

  if (path.endsWith('medicalHistory.medications')) {
    return historyValidationOutcomeMap.HS_005;
  }

  return null;
};

router.post('/visits/:id/history', async (req, res) => {
  const visitIdResult = visitIdParamSchema.safeParse(req.params.id);
  if (!visitIdResult.success) {
    return sendContractError(res, 400, 'VALIDATION_INVALID_VISIT_ID', 'Visit id must be a valid UUID');
  }

  const payloadResult = doctorVisitHistorySaveSchema.safeParse(req.body);
  if (!payloadResult.success) {
    const mappedIssue = mapDoctorHistoryPayloadIssue(payloadResult.error.issues[0]);
    if (mappedIssue) {
      return sendContractError(res, 400, mappedIssue.code, mappedIssue.message);
    }
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_DOCTOR_HISTORY_PAYLOAD',
      payloadResult.error.issues[0]?.message || 'Invalid doctor history payload'
    );
  }

  try {
    const result = await saveDoctorVisitHistory({
      actor: {
        authUserId: req.user?.authUserId,
        profileId: req.user?.profileId,
        tenantId: req.user?.tenantId,
        facilityId: req.user?.facilityId,
        role: req.user?.role,
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') || null,
      },
      visitId: visitIdResult.data,
      payload: payloadResult.data,
    });

    if (result.ok === false) {
      return sendContractError(res, result.status, result.code, result.message);
    }

    return res.json(result.data);
  } catch (error: any) {
    return sendContractError(
      res,
      500,
      'CONFLICT_DOCTOR_HISTORY_SAVE_FAILED',
      error?.message || 'Failed to save doctor visit history'
    );
  }
});

router.post('/cdss/evaluate', async (req, res) => {
  const parsed = cdssEvaluateRequestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return sendContractError(
      res,
      400,
      'VALIDATION_INVALID_CDSS_PAYLOAD',
      parsed.error.issues[0]?.message || 'Invalid CDSS evaluation payload'
    );
  }

  try {
    const result = await evaluateCdss(parsed.data);
    return res.json(result);
  } catch (error: any) {
    return sendContractError(
      res,
      500,
      'CONFLICT_CDSS_EVALUATION_FAILED',
      error?.message || 'Failed to evaluate CDSS rules'
    );
  }
});

const getPatientVisitCounts = async (facilityId: string, patientIds: string[]) => {
  if (patientIds.length === 0) return {};
  const { data, error } = await supabaseAdmin
    .from('visits')
    .select('patient_id')
    .eq('facility_id', facilityId)
    .in('patient_id', patientIds);

  if (error) return {};

  const counts: Record<string, number> = {};
  (data || []).forEach((visit: any) => {
    counts[visit.patient_id] = (counts[visit.patient_id] || 0) + 1;
  });
  return counts;
};

const getPatientTypeBadge = (visitCount: number) => {
  if (visitCount === 0) return null;
  if (visitCount === 1) return 'New';
  if (visitCount <= 5) return 'Returning';
  return 'Frequent';
};

const enrichVisits = (visits: any[], visitCounts: Record<string, number>, visitIdsWithResults: Set<string>) => {
  return (visits || []).map((visit: any) => {
    const isReturnedFromPharmacy =
      visit.status === 'with_doctor' && visit.visit_notes?.includes('Returned from pharmacy to doctor');

    return {
      ...visit,
      patientTypeBadge: getPatientTypeBadge(visitCounts[visit.patient_id] || 0),
      isReturnedFromPharmacy,
      hasResults: visitIdsWithResults.has(visit.id),
    };
  });
};

router.get('/queues', async (req, res) => {
  const { facilityId, profileId: doctorId, tenantId, role } = req.user!;
  if (!facilityId || !doctorId) {
    return res.status(400).json({ error: 'Missing facility or user context' });
  }

  try {
    const unassessedQuery = supabaseAdmin
      .from('visits_with_current_stage')
      .select(`
        id,
        patient_id,
        visit_date,
        reason,
        provider,
        temperature,
        weight,
        blood_pressure,
        heart_rate,
        respiratory_rate,
        oxygen_saturation,
        pain_score,
        visit_notes,
        triage_urgency,
        triage_triggers,
        created_at,
        status,
        status_updated_at,
        fee_paid,
        admission_ward,
        admission_bed,
        admitted_at,
        opd_room,
        assigned_doctor,
        journey_timeline,
        current_journey_stage,
        patients!inner (
          id,
          full_name,
          phone,
          age,
          gender
        )
      `)
      .eq('facility_id', facilityId)
      .eq('assigned_doctor', doctorId)
      .eq('current_journey_stage', 'with_doctor')
      .eq('assessment_completed', false)
      .order('created_at', { ascending: false })
      .limit(50);

    const diagnosticQuery = supabaseAdmin
      .from('visits_with_current_stage')
      .select(`
        id,
        patient_id,
        visit_date,
        reason,
        provider,
        temperature,
        weight,
        blood_pressure,
        heart_rate,
        respiratory_rate,
        oxygen_saturation,
        pain_score,
        visit_notes,
        triage_urgency,
        triage_triggers,
        created_at,
        status,
        status_updated_at,
        fee_paid,
        admission_ward,
        admission_bed,
        admitted_at,
        opd_room,
        assigned_doctor,
        journey_timeline,
        current_journey_stage,
        patients!inner (
          id,
          full_name,
          phone,
          age,
          gender
        )
      `)
      .eq('facility_id', facilityId)
      .eq('assigned_doctor', doctorId)
      .neq('status', 'discharged')
      .neq('current_journey_stage', 'discharged')
      .in('current_journey_stage', ['at_pharmacy', 'at_lab', 'at_imaging', 'paying_diagnosis', 'paying_pharmacy'])
      .order('created_at', { ascending: false })
      .limit(50);

    const dischargedQuery = supabaseAdmin
      .from('visits_with_current_stage')
      .select(`
        id,
        patient_id,
        visit_date,
        reason,
        provider,
        temperature,
        weight,
        blood_pressure,
        heart_rate,
        respiratory_rate,
        oxygen_saturation,
        pain_score,
        visit_notes,
        created_at,
        status,
        status_updated_at,
        fee_paid,
        journey_timeline,
        patients!inner (
          id,
          full_name,
          phone,
          age,
          gender
        )
      `)
      .eq('facility_id', facilityId)
      .eq('assigned_doctor', doctorId)
      .eq('status', 'discharged')
      .order('status_updated_at', { ascending: false })
      .limit(50);

    const [unassessedResult, diagnosticResult, dischargedResult] = await Promise.all([
      unassessedQuery,
      diagnosticQuery,
      dischargedQuery,
    ]);

    if (unassessedResult.error) throw unassessedResult.error;
    if (diagnosticResult.error) throw diagnosticResult.error;
    if (dischargedResult.error) throw dischargedResult.error;

    const unassessedVisits = unassessedResult.data || [];
    const diagnosticVisits = diagnosticResult.data || [];
    const dischargedVisits = dischargedResult.data || [];

    const allVisitIds = [
      ...unassessedVisits.map((v: any) => v.id),
      ...diagnosticVisits.map((v: any) => v.id),
    ];

    const [labResults, imagingResults] = await Promise.all([
      supabaseAdmin
        .from('lab_orders')
        .select('visit_id, status, completed_at')
        .in('visit_id', allVisitIds)
        .eq('status', 'completed')
        .not('completed_at', 'is', null),
      supabaseAdmin
        .from('imaging_orders')
        .select('visit_id, status, completed_at')
        .in('visit_id', allVisitIds)
        .eq('status', 'completed')
        .not('completed_at', 'is', null),
    ]);

    if (labResults.error) throw labResults.error;
    if (imagingResults.error) throw imagingResults.error;

    const visitIdsWithResults = new Set([
      ...(labResults.data || []).map((r: any) => r.visit_id),
      ...(imagingResults.data || []).map((r: any) => r.visit_id),
    ]);

    const patientIds = [
      ...unassessedVisits.map((v: any) => v.patient_id),
      ...diagnosticVisits.map((v: any) => v.patient_id),
      ...dischargedVisits.map((v: any) => v.patient_id),
    ];
    const visitCounts = await getPatientVisitCounts(facilityId, patientIds);

    const unassessedPatients = enrichVisits(unassessedVisits, visitCounts, visitIdsWithResults);
    const diagnosticPatients = enrichVisits(diagnosticVisits, visitCounts, visitIdsWithResults);
    const dischargedPatients = dischargedVisits.map((visit: any) => ({
      ...visit,
      patientTypeBadge: getPatientTypeBadge(visitCounts[visit.patient_id] || 0),
    }));

    const [labReady, imagingReady] = await Promise.all([
      supabaseAdmin
        .from('lab_orders')
        .select('visit_id, status, completed_at, visits!inner(facility_id, assigned_doctor)')
        .eq('visits.facility_id', facilityId)
        .eq('visits.assigned_doctor', doctorId)
        .eq('status', 'completed')
        .not('completed_at', 'is', null),
      supabaseAdmin
        .from('imaging_orders')
        .select('visit_id, status, completed_at, visits!inner(facility_id, assigned_doctor)')
        .eq('visits.facility_id', facilityId)
        .eq('visits.assigned_doctor', doctorId)
        .eq('status', 'completed')
        .not('completed_at', 'is', null),
    ]);

    if (labReady.error) throw labReady.error;
    if (imagingReady.error) throw imagingReady.error;

    const resultVisitIds = new Set([
      ...(labReady.data || []).map((r: any) => r.visit_id),
      ...(imagingReady.data || []).map((r: any) => r.visit_id),
    ]);

    let resultsReadyPatients: any[] = [];
    if (resultVisitIds.size > 0) {
      const { data: resultVisits, error: resultVisitsError } = await supabaseAdmin
        .from('visits')
        .select(`
          id,
          patient_id,
          visit_date,
          reason,
          provider,
          temperature,
          weight,
          blood_pressure,
          heart_rate,
          respiratory_rate,
          oxygen_saturation,
          pain_score,
          visit_notes,
          triage_urgency,
          triage_triggers,
          created_at,
          status,
          status_updated_at,
          fee_paid,
          admission_ward,
          admission_bed,
          admitted_at,
          opd_room,
          assigned_doctor,
          patients (
            id,
            full_name,
            phone,
            age,
            gender
          )
        `)
        .in('id', Array.from(resultVisitIds))
        .eq('facility_id', facilityId)
        .eq('assigned_doctor', doctorId)
        .neq('status', 'discharged')
        .order('created_at', { ascending: false });

      if (resultVisitsError) throw resultVisitsError;

      const resultPatientIds = (resultVisits || []).map((v: any) => v.patient_id);
      const resultCounts = await getPatientVisitCounts(facilityId, resultPatientIds);
      resultsReadyPatients = (resultVisits || []).map((visit: any) => ({
        ...visit,
        patientTypeBadge: getPatientTypeBadge(resultCounts[visit.patient_id] || 0),
        hasResults: true,
      }));
    }

    const { data: admissions, error: admissionsError } = await supabaseAdmin
      .from('admissions')
      .select(
        `
          id,
          patient_id,
          admission_date,
          admitting_diagnosis,
          ward_id,
          bed_id,
          status,
          patients!inner (
            id,
            full_name,
            phone,
            age,
            gender
          )
        `
      )
      .eq('facility_id', facilityId)
      .eq('admitting_doctor_id', doctorId)
      .eq('status', 'admitted')
      .order('admission_date', { ascending: false });

    if (admissionsError) throw admissionsError;

    const admissionPatientIds = (admissions || []).map((a: any) => a.patient_id);
    const admissionCounts = await getPatientVisitCounts(facilityId, admissionPatientIds);
    const admittedPatients = (admissions || []).map((admission: any) => ({
      id: admission.id,
      patient_id: admission.patient_id,
      visit_date: admission.admission_date,
      reason: admission.admitting_diagnosis || 'Admitted',
      provider: '',
      patients: admission.patients,
      created_at: admission.admission_date,
      status: 'admitted',
      patientTypeBadge: getPatientTypeBadge(admissionCounts[admission.patient_id] || 0),
      admission_ward: admission.ward_id,
      admission_bed: admission.bed_id,
      admitted_at: admission.admission_date,
    }));

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_doctor_queues',
        eventType: 'read',
        entityType: 'doctor_queue',
        tenantId,
        facilityId,
        actorUserId: doctorId,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: {
          unassessed_count: unassessedPatients.length,
          diagnostic_count: diagnosticPatients.length,
          results_ready_count: resultsReadyPatients.length,
          admitted_count: admittedPatients.length,
          discharged_count: dischargedPatients.length,
        },
      });
    }

    return res.json({
      unassessedPatients,
      diagnosticPatients,
      resultsReadyPatients,
      admittedPatients,
      dischargedPatients,
    });
  } catch (error: any) {
    console.error('Doctor queues error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to fetch doctor queues' });
  }
});

router.get('/inpatients', async (req, res) => {
  const { facilityId, profileId: doctorId, tenantId, role } = req.user!;
  if (!facilityId || !doctorId) {
    return res.status(400).json({ error: 'Missing facility or user context' });
  }

  try {
    const { data: visits, error } = await supabaseAdmin
      .from('visits')
      .select(`
        id,
        patient_id,
        visit_date,
        reason,
        provider,
        temperature,
        weight,
        blood_pressure,
        heart_rate,
        respiratory_rate,
        oxygen_saturation,
        pain_score,
        visit_notes,
        triage_urgency,
        triage_triggers,
        created_at,
        status,
        status_updated_at,
        fee_paid,
        admission_ward,
        admission_bed,
        admitted_at,
        assigned_doctor,
        patients (
          id,
          full_name,
          phone,
          age,
          gender
        )
      `)
      .eq('status', 'admitted')
      .eq('assigned_doctor', doctorId)
      .not('admission_ward', 'is', null)
      .not('admission_bed', 'is', null)
      .order('admitted_at', { ascending: false });

    if (error) throw error;

    const visitIds = (visits || []).map((v: any) => v.id);

    const [medicationOrders, labOrders, imagingOrders] = await Promise.all([
      supabaseAdmin
        .from('medication_orders')
        .select('visit_id')
        .in('visit_id', visitIds)
        .in('status', ['pending', 'approved']),
      supabaseAdmin
        .from('lab_orders')
        .select('visit_id')
        .in('visit_id', visitIds)
        .eq('status', 'pending'),
      supabaseAdmin
        .from('imaging_orders')
        .select('visit_id')
        .in('visit_id', visitIds)
        .eq('status', 'pending'),
    ]);

    if (medicationOrders.error) throw medicationOrders.error;
    if (labOrders.error) throw labOrders.error;
    if (imagingOrders.error) throw imagingOrders.error;

    const taskCounts: Record<string, number> = {};
    [...(medicationOrders.data || []), ...(labOrders.data || []), ...(imagingOrders.data || [])].forEach((order: any) => {
      taskCounts[order.visit_id] = (taskCounts[order.visit_id] || 0) + 1;
    });

    const enrichedVisits = (visits || []).map((visit: any) => {
      const admittedAt = visit.admitted_at ? new Date(visit.admitted_at) : null;
      const daysSinceAdmission = admittedAt
        ? Math.floor((Date.now() - admittedAt.getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      return {
        ...visit,
        wardName: visit.admission_ward || 'Unknown Ward',
        bedNumber: visit.admission_bed || 'Unknown Bed',
        admittedAt: visit.admitted_at,
        daysSinceAdmission,
        pendingTasksCount: taskCounts[visit.id] || 0,
      };
    });

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_inpatients',
        eventType: 'read',
        entityType: 'inpatient_list',
        tenantId,
        facilityId,
        actorUserId: doctorId,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { inpatient_count: enrichedVisits.length },
      });
    }

    return res.json({ inpatients: enrichedVisits });
  } catch (error: any) {
    console.error('Doctor inpatients error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to fetch doctor inpatients' });
  }
});

// ─── HYPOTHESIS: pre-consultation clinical picture ───────────────────────────
// Maps triage vitals + patient data → CDSS → a pre-formed hypothesis card.
// Called the moment a visit enters the `with_doctor` stage so the health
// worker sees a clinical picture before the consultation begins.

const PATHWAY_DRUG_KEYWORDS: Record<string, string[]> = {
  fever: ['artemether', 'lumefantrine', 'artemisinin', 'rdt', 'malaria', 'paracetamol', 'acetaminophen', 'antipyretic'],
  respiratory: ['amoxicillin', 'azithromycin', 'salbutamol', 'prednisolone', 'oxygen', 'bronchodilator'],
  maternal: ['oxytocin', 'magnesium', 'methyldopa', 'labetalol', 'misoprostol', 'iron', 'folate'],
  pediatric: ['amoxicillin', 'zinc', 'ors', 'rehydration', 'paracetamol', 'vitamin'],
  cardiac: ['aspirin', 'atenolol', 'amlodipine', 'furosemide', 'captopril'],
  default: ['paracetamol', 'amoxicillin', 'metronidazole', 'ors'],
};

const resolvePathwayKeys = (cohort: string, hardStops: any[], warnings: any[], chiefComplaint: string): string[] => {
  const keys = new Set<string>();
  const text = [chiefComplaint, ...hardStops.map((h: any) => h.message), ...warnings.map((w: any) => w.message)]
    .join(' ')
    .toLowerCase();

  if (cohort === 'maternal') keys.add('maternal');
  if (cohort === 'pediatric') keys.add('pediatric');
  if (/fever|malaria|temperature|febrile/.test(text)) keys.add('fever');
  if (/breath|respir|oxygen|cough|chest|spo2/.test(text)) keys.add('respiratory');
  if (/heart|cardiac|chest pain|bp|hypertens/.test(text)) keys.add('cardiac');
  if (keys.size === 0) keys.add('default');
  return Array.from(keys);
};

router.get('/visits/:id/hypothesis', async (req, res) => {
  const visitIdResult = visitIdParamSchema.safeParse(req.params.id);
  if (!visitIdResult.success) {
    return sendContractError(res, 400, 'VALIDATION_INVALID_VISIT_ID', 'Visit id must be a valid UUID');
  }

  const { facilityId } = req.user!;
  if (!facilityId) return res.status(400).json({ error: 'Missing facility context' });

  try {
    // 1. Fetch visit with patient + vitals
    const { data: visit, error: visitError } = await supabaseAdmin
      .from('visits_with_current_stage')
      .select(`
        id,
        patient_id,
        reason,
        visit_notes,
        triage_urgency,
        triage_triggers,
        temperature,
        blood_pressure,
        heart_rate,
        respiratory_rate,
        oxygen_saturation,
        weight,
        pain_score,
        patients (
          id,
          full_name,
          age,
          gender
        )
      `)
      .eq('id', visitIdResult.data)
      .eq('facility_id', facilityId)
      .single();

    if (visitError || !visit) {
      return sendContractError(res, 404, 'NOT_FOUND_VISIT', 'Visit not found');
    }

    const patient = (visit as any).patients as any;
    const ageYears = patient?.age ?? null;
    const sex = patient?.gender ?? null;
    const chiefComplaint = (visit as any).reason || (visit as any).visit_notes || '';

    // 2. Build CDSS input from triage data
    const cdssInput = {
      checkpoint: 'triage' as const,
      patient: { ageYears, sex, pregnant: null },
      vitals: {
        temperature: (visit as any).temperature ?? null,
        bloodPressure: (visit as any).blood_pressure ?? null,
        heartRate: (visit as any).heart_rate ?? null,
        respiratoryRate: (visit as any).respiratory_rate ?? null,
        oxygenSaturation: (visit as any).oxygen_saturation ?? null,
        weightKg: (visit as any).weight ?? null,
      },
      symptoms: (visit as any).triage_triggers || [],
      chiefComplaint,
      clinicalNotes: (visit as any).visit_notes || null,
      diagnosis: null,
      pendingOrders: [],
      acknowledgeOutstandingOrders: false,
      includeAiAdvisory: false,
    };

    // 3. Run CDSS
    const cdssResult = await evaluateCdss(cdssInput);

    // 4. Determine drug pathway and fetch relevant stock
    const pathwayKeys = resolvePathwayKeys(
      cdssResult.cohort,
      cdssResult.hardStops,
      cdssResult.warnings,
      chiefComplaint
    );
    const drugKeywords = [...new Set(pathwayKeys.flatMap((k) => PATHWAY_DRUG_KEYWORDS[k] || []))];

    const stockPromises = drugKeywords.slice(0, 8).map((keyword) =>
      supabaseAdmin
        .from('inventory_items')
        .select('id, name, generic_name, current_quantity, reorder_level, dosage_form, strength')
        .eq('facility_id', facilityId)
        .eq('is_active', true)
        .ilike('name', `%${keyword}%`)
        .limit(2)
    );

    const stockResults = await Promise.all(stockPromises);
    const seenIds = new Set<string>();
    const relevantStock = stockResults
      .flatMap((r) => r.data || [])
      .filter((item: any) => {
        if (seenIds.has(item.id)) return false;
        seenIds.add(item.id);
        return true;
      })
      .slice(0, 8)
      .map((item: any) => {
        const qty = item.current_quantity ?? 0;
        const reorder = item.reorder_level ?? 0;
        const status: 'in_stock' | 'low_stock' | 'out_of_stock' =
          qty <= 0 ? 'out_of_stock' : qty <= reorder ? 'low_stock' : 'in_stock';
        return {
          id: item.id,
          name: item.name,
          genericName: item.generic_name,
          dosageForm: item.dosage_form,
          strength: item.strength,
          currentQuantity: qty,
          status,
        };
      });

    return res.json({
      visitId: visitIdResult.data,
      patient: {
        name: patient?.full_name,
        age: ageYears,
        gender: sex,
      },
      chiefComplaint,
      triageUrgency: (visit as any).triage_urgency,
      cdss: {
        cohort: cdssResult.cohort,
        hardStops: cdssResult.hardStops,
        warnings: cdssResult.warnings,
        recommendations: cdssResult.recommendations,
        referral: cdssResult.referral,
        briefSummary: cdssResult.briefSummary,
      },
      pathwayKeys,
      relevantStock,
    });
  } catch (error: any) {
    console.error('Hypothesis error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_HYPOTHESIS_FAILED', error?.message || 'Failed to generate hypothesis');
  }
});

// ─── DEBRIEF: post-consultation skill-building summary ───────────────────────
// After the consultation closes, this surfaces a quiet comparison between
// what the clinician did and what the protocol expected — not as a score,
// but as a learning moment.

router.get('/visits/:id/debrief', async (req, res) => {
  const visitIdResult = visitIdParamSchema.safeParse(req.params.id);
  if (!visitIdResult.success) {
    return sendContractError(res, 400, 'VALIDATION_INVALID_VISIT_ID', 'Visit id must be a valid UUID');
  }

  const { facilityId, profileId: clinicianId } = req.user!;
  if (!facilityId) return res.status(400).json({ error: 'Missing facility context' });

  try {
    // 1. Fetch visit + patient
    const { data: visit, error: visitError } = await supabaseAdmin
      .from('visits')
      .select(`
        id,
        patient_id,
        reason,
        visit_notes,
        triage_urgency,
        triage_triggers,
        temperature,
        blood_pressure,
        heart_rate,
        respiratory_rate,
        oxygen_saturation,
        weight,
        created_at,
        status_updated_at,
        patients ( id, full_name, age, gender )
      `)
      .eq('id', visitIdResult.data)
      .eq('facility_id', facilityId)
      .single();

    if (visitError || !visit) {
      return sendContractError(res, 404, 'NOT_FOUND_VISIT', 'Visit not found');
    }

    // 2. Fetch doctor visit history (clinical notes + diagnosis)
    const { data: history } = await supabaseAdmin
      .from('doctor_visit_histories')
      .select('chief_complaints, assessment, treatment_plan, diagnosis, created_at, updated_at')
      .eq('visit_id', visitIdResult.data)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // 3. Fetch medication orders placed during this visit
    const { data: medOrders } = await supabaseAdmin
      .from('medication_orders')
      .select('medication_name, generic_name, dosage, route, frequency, status, created_at')
      .eq('visit_id', visitIdResult.data)
      .order('created_at', { ascending: true });

    // 4. Re-run CDSS at consult checkpoint with saved data to get protocol expectation
    const patient = (visit as any).patients as any;
    const symptoms: string[] = [
      ...((visit as any).triage_triggers || []),
      ...((history as any)?.chief_complaints?.flatMap((cc: any) => cc.hpi?.associatedSymptoms || []) || []),
    ];

    const cdssInput = {
      checkpoint: 'consult' as const,
      patient: {
        ageYears: patient?.age ?? null,
        sex: patient?.gender ?? null,
        pregnant: null,
      },
      vitals: {
        temperature: (visit as any).temperature ?? null,
        bloodPressure: (visit as any).blood_pressure ?? null,
        heartRate: (visit as any).heart_rate ?? null,
        respiratoryRate: (visit as any).respiratory_rate ?? null,
        oxygenSaturation: (visit as any).oxygen_saturation ?? null,
        weightKg: (visit as any).weight ?? null,
      },
      symptoms,
      chiefComplaint: (visit as any).reason || '',
      clinicalNotes: (visit as any).visit_notes || null,
      diagnosis: (history as any)?.diagnosis || null,
      pendingOrders: [],
      acknowledgeOutstandingOrders: true,
      includeAiAdvisory: false,
    };

    const cdssResult = await evaluateCdss(cdssInput);

    // 5. Build divergence analysis
    const divergences: Array<{ type: 'missed_recommendation' | 'unaddressed_warning'; description: string }> = [];

    // Check if any hard stops or warnings were present that may not have been addressed
    cdssResult.hardStops.forEach((stop: any) => {
      divergences.push({
        type: 'unaddressed_warning',
        description: `Protocol hard-stop triggered: ${stop.message}`,
      });
    });

    cdssResult.warnings.forEach((warn: any) => {
      const diagText = ((history as any)?.diagnosis || '').toLowerCase();
      const notesText = ((history as any)?.treatment_plan || '').toLowerCase();
      const mentionedInDocs = warn.message.split(' ')
        .filter((w: string) => w.length > 4)
        .some((w: string) => diagText.includes(w.toLowerCase()) || notesText.includes(w.toLowerCase()));
      if (!mentionedInDocs) {
        divergences.push({
          type: 'missed_recommendation',
          description: warn.message,
        });
      }
    });

    // 6. Compute duration
    const startTime = new Date((visit as any).created_at).getTime();
    const endTime = (visit as any).status_updated_at
      ? new Date((visit as any).status_updated_at).getTime()
      : Date.now();
    const durationMinutes = Math.round((endTime - startTime) / 60000);

    const verdict: 'correct' | 'partial' | 'review' =
      divergences.length === 0 ? 'correct' : divergences.length <= 2 ? 'partial' : 'review';

    return res.json({
      visitId: visitIdResult.data,
      patient: { name: patient?.full_name, age: patient?.age, gender: patient?.gender },
      durationMinutes,
      verdict,
      divergences,
      cdssExpectation: {
        cohort: cdssResult.cohort,
        hardStops: cdssResult.hardStops,
        warnings: cdssResult.warnings,
        recommendations: cdssResult.recommendations,
        briefSummary: cdssResult.briefSummary,
      },
      medicationsPrescribed: (medOrders || []).map((m: any) => ({
        name: m.medication_name,
        genericName: m.generic_name,
        dosage: m.dosage,
        route: m.route,
        frequency: m.frequency,
      })),
      diagnosis: (history as any)?.diagnosis || null,
      insights: [
        cdssResult.briefSummary.text,
        ...(cdssResult.recommendations.slice(0, 2).map((r: any) => r.text)),
      ].filter(Boolean),
    });
  } catch (error: any) {
    console.error('Debrief error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_DEBRIEF_FAILED', error?.message || 'Failed to generate debrief');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CDSS Background Recommendation Logging
// ─────────────────────────────────────────────────────────────────────────────

const cdssRecBodySchema = z.object({
  recommendation_type: z.enum(['diagnosis', 'treatment', 'alert', 'referral']),
  recommendation_text: z.string().min(1).max(2000),
  source:             z.string().max(255).optional().nullable(),
  context_snapshot:   z.record(z.unknown()).optional().nullable(),
});

const cdssRecResponseSchema = z.object({
  doctor_response: z.enum(['accepted', 'ignored']),
  responded_at:    z.string().datetime().optional(),
});

/** POST /doctor/visits/:visitId/cdss-recommendations
 *  Log a new background CDSS recommendation shown to the doctor.
 */
router.post('/visits/:visitId/cdss-recommendations', async (req, res) => {
  const visitId = visitIdParamSchema.safeParse(req.params.visitId);
  if (!visitId.success) {
    return sendContractError(res, 400, 'VALIDATION_INVALID_VISIT_ID', 'Invalid visit ID');
  }

  const body = cdssRecBodySchema.safeParse(req.body || {});
  if (!body.success) {
    return sendContractError(
      res, 400, 'VALIDATION_INVALID_CDSS_REC_PAYLOAD',
      body.error.issues[0]?.message || 'Invalid recommendation payload'
    );
  }

  const { tenantId, facilityId, profileId } = req.user!;

  try {
    // Verify the visit belongs to this facility
    const { data: visit, error: visitErr } = await supabaseAdmin
      .from('visits')
      .select('id, facility_id, tenant_id')
      .eq('id', visitId.data)
      .eq('facility_id', facilityId)
      .single();

    if (visitErr || !visit) {
      return sendContractError(res, 404, 'NOT_FOUND_VISIT', 'Visit not found');
    }

    const { data: rec, error: insertErr } = await supabaseAdmin
      .from('cdss_recommendations')
      .insert({
        visit_id:            visitId.data,
        tenant_id:           tenantId,
        facility_id:         facilityId,
        recommendation_type: body.data.recommendation_type,
        recommendation_text: body.data.recommendation_text,
        source:              body.data.source ?? null,
        context_snapshot:    body.data.context_snapshot ?? null,
        doctor_response:     'pending',
      })
      .select('id, created_at')
      .single();

    if (insertErr || !rec) {
      console.error('CDSS rec insert error:', insertErr?.message);
      return sendContractError(res, 500, 'CONFLICT_CDSS_REC_INSERT_FAILED', 'Failed to log recommendation');
    }

    await recordAuditEvent({
      action:        'cdss_recommendation_logged',
      eventType:     'clinical_decision_support',
      entityType:    'cdss_recommendation',
      tenantId,
      facilityId,
      actorUserId:   profileId,
      metadata: {
        visit_id:            visitId.data,
        recommendation_type: body.data.recommendation_type,
        rec_id:              rec.id,
      },
    });

    return res.status(201).json({ success: true, id: rec.id, created_at: rec.created_at });
  } catch (error: any) {
    console.error('CDSS rec log error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_CDSS_REC_LOG_FAILED', error?.message || 'Failed to log recommendation');
  }
});

/** PATCH /doctor/visits/:visitId/cdss-recommendations/:recId
 *  Record the doctor's response (accepted | ignored) to a logged recommendation.
 */
router.patch('/visits/:visitId/cdss-recommendations/:recId', async (req, res) => {
  const visitId = visitIdParamSchema.safeParse(req.params.visitId);
  const recId   = visitIdParamSchema.safeParse(req.params.recId);
  if (!visitId.success || !recId.success) {
    return sendContractError(res, 400, 'VALIDATION_INVALID_IDS', 'Invalid visit or recommendation ID');
  }

  const body = cdssRecResponseSchema.safeParse(req.body || {});
  if (!body.success) {
    return sendContractError(
      res, 400, 'VALIDATION_INVALID_CDSS_RESPONSE_PAYLOAD',
      body.error.issues[0]?.message || 'Invalid response payload'
    );
  }

  const { tenantId, facilityId, profileId } = req.user!;

  try {
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('cdss_recommendations')
      .update({
        doctor_response: body.data.doctor_response,
        responded_at:    body.data.responded_at ?? new Date().toISOString(),
      })
      .eq('id', recId.data)
      .eq('visit_id', visitId.data)
      .eq('facility_id', facilityId)
      .select('id, doctor_response, responded_at')
      .single();

    if (updateErr || !updated) {
      return sendContractError(res, 404, 'NOT_FOUND_CDSS_REC', 'Recommendation not found or already responded');
    }

    await recordAuditEvent({
      action:        'cdss_recommendation_responded',
      eventType:     'clinical_decision_support',
      entityType:    'cdss_recommendation',
      tenantId,
      facilityId,
      actorUserId:   profileId,
      metadata: {
        rec_id:          recId.data,
        visit_id:        visitId.data,
        doctor_response: body.data.doctor_response,
      },
    });

    return res.json({ success: true, ...updated });
  } catch (error: any) {
    console.error('CDSS rec respond error:', error?.message || error);
    return sendContractError(res, 500, 'CONFLICT_CDSS_REC_RESPOND_FAILED', error?.message || 'Failed to update recommendation');
  }
});

export default router;

