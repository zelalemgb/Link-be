import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';
import {
  doctorVisitHistorySaveSchema,
  saveDoctorVisitHistory,
} from '../services/doctorVisitHistoryService';

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

export default router;
