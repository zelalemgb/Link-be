import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { ensurePatientAccountLink } from '../services/patientAccountLinking';
import { recordAuditEvent } from '../services/audit-log';
import { JOURNEY_STAGES } from '../../shared/contracts/journey';
import {
    updateVisitStatusMutation,
    visitStatusMutationSchema,
} from '../services/patientVisitStatusService';
import {
    maybeAssertProviderPhiConsentForPatient,
} from '../services/providerPhiConsentGuard';

const router = Router();
router.use(requireUser, requireScopedUser);

const PHI_PORTAL_CONSENT_TYPE = 'records_access';

const journeyStageSchema = z.enum(JOURNEY_STAGES);
const appendStageSchema = z.object({
    stage: journeyStageSchema,
});
const orderHistoryQuerySchema = z.object({
    type: z.enum(['lab', 'imaging', 'medications']),
    excludeVisitId: z.string().uuid().optional(),
    limit: z.coerce.number().min(1).max(20).optional(),
});
// Schema for creating a visit
const createVisitSchema = z.object({
    visitDate: z.string(),
    reason: z.string(),
    provider: z.string(),
    feePaid: z.number(), // or string, but prefer number
    visitNotes: z.string().optional(),
    consultationServiceId: z.string().optional(),
});

const CONSENT_BLOCKING_CODES = new Set([
    'PERM_PHI_CONSENT_REQUIRED',
    'CONFLICT_CONSENT_ACCESS_REVOKED',
]);

/**
 * GET /api/patients/search
 * Query params: q (search term)
 */
router.get('/search', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    const q = req.query.q as string;

    if (!q || q.length < 2) {
        return res.json([]);
    }

    try {
        const searchTerm = `%${q}%`;
        const { data, error } = await supabaseAdmin
            .from('patients')
            .select(`
          id,
          first_name,
          last_name,
          full_name,
          fayida_id,
          date_of_birth,
          gender,
          phone,
          visits (
            id,
            visit_date,
            status,
            reason,
            triage_urgency
          )
        `)
            .eq('facility_id', facilityId)
            .or(`first_name.ilike.${searchTerm},last_name.ilike.${searchTerm},full_name.ilike.${searchTerm},phone.ilike.${searchTerm},fayida_id.ilike.${searchTerm}`)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        const searchedPatients = Array.isArray(data) ? data : [];
        let consentScopedPatients = searchedPatients;

        if (tenantId && facilityId && searchedPatients.length > 0) {
            const permittedPatients: any[] = [];
            for (const patient of searchedPatients) {
                const consentCheck = await maybeAssertProviderPhiConsentForPatient({
                    tenantId,
                    facilityId,
                    patientId: patient.id,
                    consentType: PHI_PORTAL_CONSENT_TYPE,
                });
                if (consentCheck.ok === false) {
                    if (CONSENT_BLOCKING_CODES.has(consentCheck.code)) {
                        continue;
                    }
                    return res.status(consentCheck.status).json({
                        code: consentCheck.code,
                        message: consentCheck.message,
                    });
                }
                permittedPatients.push(patient);
            }
            consentScopedPatients = permittedPatients;
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'search',
                eventType: 'read',
                entityType: 'patient',
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                metadata: {
                    result_count: consentScopedPatients.length,
                    filtered_out_count: searchedPatients.length - consentScopedPatients.length,
                },
                requestId: req.requestId || null,
            });
        }
        res.json(consentScopedPatients);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/patients/:id/visits/history
 */
router.get('/:id/visits/history', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    const limit = parseInt(req.query.limit as string) || 5;
    try {
        const consentCheck = await maybeAssertProviderPhiConsentForPatient({
            tenantId,
            facilityId,
            patientId: req.params.id,
            consentType: PHI_PORTAL_CONSENT_TYPE,
        });
        if (consentCheck.ok === false) {
            return res.status(consentCheck.status).json({
                code: consentCheck.code,
                message: consentCheck.message,
            });
        }

        let query = supabaseAdmin
            .from('visits')
            .select('id, visit_date, reason, status, provider, visit_notes, clinical_notes, fee_paid, temperature, weight, blood_pressure, heart_rate, respiratory_rate, oxygen_saturation, pain_score')
            .eq('patient_id', req.params.id)
            .order('visit_date', { ascending: false })
            .limit(limit);

        if (facilityId) {
            query = query.eq('facility_id', facilityId);
        }
        if (tenantId) {
            query = query.eq('tenant_id', tenantId);
        }

        const { data, error } = await query;

        if (error) throw error;

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_visit_history',
                eventType: 'read',
                entityType: 'patient',
                entityId: req.params.id,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
            });
        }

        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/patients/visits/:id/orders
 * Fetch lab, imaging, medication, and procedure orders for a visit
 */
router.get('/visits/:id/orders', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    const visitId = req.params.id;

    try {
        const { data: visitRow, error: visitError } = await supabaseAdmin
            .from('visits')
            .select('id, facility_id, tenant_id, patient_id')
            .eq('id', visitId)
            .maybeSingle();

        if (visitError) throw visitError;
        if (!visitRow) return res.status(404).json({ error: 'Visit not found' });

        if (facilityId && visitRow.facility_id !== facilityId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (tenantId && visitRow.tenant_id !== tenantId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const consentCheck = await maybeAssertProviderPhiConsentForPatient({
            tenantId,
            facilityId,
            patientId: visitRow.patient_id,
            consentType: PHI_PORTAL_CONSENT_TYPE,
        });
        if (consentCheck.ok === false) {
            return res.status(consentCheck.status).json({
                code: consentCheck.code,
                message: consentCheck.message,
            });
        }

        const [labOrdersResult, imagingOrdersResult, medicationOrdersResult, billingItemsResult] = await Promise.all([
            supabaseAdmin
                .from('lab_orders')
                .select('id, test_name, test_code, urgency, status, result, result_value, reference_range, ordered_at, collected_at, completed_at, payment_status, payment_mode, amount, paid_at, notes, sent_outside')
                .eq('visit_id', visitId),
            supabaseAdmin
                .from('imaging_orders')
                .select('id, study_name, study_code, body_part, urgency, status, result, findings, impression, ordered_at, scheduled_at, completed_at, payment_status, payment_mode, amount, paid_at, notes, sent_outside')
                .eq('visit_id', visitId),
            supabaseAdmin
                .from('medication_orders')
                .select('id, medication_name, generic_name, dosage, frequency, route, duration, quantity, refills, status, notes, ordered_at, dispensed_at, payment_status, payment_mode, amount, paid_at, sent_outside')
                .eq('visit_id', visitId),
            supabaseAdmin
                .from('billing_items')
                .select('id, payment_status, medical_services (name, category)')
                .eq('visit_id', visitId),
        ]);

        if (labOrdersResult.error) throw labOrdersResult.error;
        if (imagingOrdersResult.error) throw imagingOrdersResult.error;
        if (medicationOrdersResult.error) throw medicationOrdersResult.error;
        if (billingItemsResult.error) throw billingItemsResult.error;

        const labOrders = (labOrdersResult.data || []).map((order: any) => ({
            id: order.id,
            test_name: order.test_name,
            test_code: order.test_code || '',
            urgency: order.urgency,
            notes: order.notes || '',
            status: order.status,
            result: order.result_value || order.result || '',
            result_value: order.result_value || null,
            reference_range: order.reference_range || null,
            payment_status: order.payment_status,
            paid_at: order.paid_at,
            sent_outside: order.sent_outside || false,
            savedFromRecord: true
        }));

        const imagingOrders = (imagingOrdersResult.data || []).map((order: any) => ({
            id: order.id,
            study_name: order.study_name,
            study_code: order.study_code || '',
            body_part: order.body_part || '',
            urgency: order.urgency,
            notes: order.notes || '',
            status: order.status,
            findings: order.findings || '',
            impression: order.impression || '',
            result: order.result || '',
            image_url: order.image_url || order.dicom_url || order.file_url || null,
            dicom_url: order.dicom_url || null,
            storage_path: order.storage_path || order.image_path || order.dicom_path || null,
            image_path: order.image_path || null,
            dicom_path: order.dicom_path || null,
            file_url: order.file_url || null,
            payment_status: order.payment_status,
            paid_at: order.paid_at,
            sent_outside: order.sent_outside || false,
            savedFromRecord: true
        }));

        const medicationOrders = (medicationOrdersResult.data || []).map((order: any) => ({
            id: order.id,
            medication_name: order.medication_name,
            generic_name: order.generic_name || '',
            dosage: order.dosage,
            frequency: order.frequency,
            route: order.route,
            duration: order.duration || '',
            quantity: order.quantity || 0,
            refills: order.refills || 0,
            notes: order.notes || '',
            status: order.status,
            payment_status: order.payment_status,
            paid_at: order.paid_at,
            dispensed_at: order.dispensed_at,
            sent_outside: order.sent_outside || false,
            savedFromRecord: true
        }));

        const procedureOrders = (billingItemsResult.data || [])
            .filter((item: any) => item.medical_services?.category === 'Procedures')
            .map((item: any) => ({
                id: item.id,
                procedure_name: item.medical_services?.name || 'Unknown Procedure',
                notes: '',
                status: item.payment_status === 'paid' ? 'completed' : 'pending',
                savedFromRecord: true
            }));

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_orders',
                eventType: 'read',
                entityType: 'visit',
                entityId: visitId,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
            });
        }

        return res.json({ labOrders, imagingOrders, medicationOrders, procedureOrders });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Failed to fetch patient orders' });
    }
});

/**
 * PATCH /api/patients/visits/:id/status
 * Update visit status and notes.
 */
router.patch('/visits/:id/status', async (req, res) => {
    const visitId = req.params.id;
    const parsed = visitStatusMutationSchema.safeParse(req.body);
    if (!parsed.success) {
        return res
            .status(400)
            .json({
                code: 'VALIDATION_INVALID_VISIT_STATUS_PAYLOAD',
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
    }

    try {
        const result = await updateVisitStatusMutation({
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
            visitId,
            payload: parsed.data,
        });

        if (result.ok === false) {
            return res.status(result.status).json({
                code: result.code,
                message: result.message,
            });
        }

        return res.json(result.data);
    } catch (error: any) {
        return res.status(500).json({
            code: 'CONFLICT_VISIT_STATUS_UPDATE_FAILED',
            message: error.message || 'Failed to update visit status',
        });
    }
});

/**
 * GET /api/patients/:id/orders/history
 * Query params: type=lab|imaging|medications, excludeVisitId (optional), limit (optional)
 */
router.get('/:id/orders/history', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    const parsed = orderHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
    }

    const { type, excludeVisitId, limit = 5 } = parsed.data;

    try {
        const consentCheck = await maybeAssertProviderPhiConsentForPatient({
            tenantId,
            facilityId,
            patientId: req.params.id,
            consentType: PHI_PORTAL_CONSENT_TYPE,
        });
        if (consentCheck.ok === false) {
            return res.status(consentCheck.status).json({
                code: consentCheck.code,
                message: consentCheck.message,
            });
        }

        let table = '';
        let select = '';
        if (type === 'lab') {
            table = 'lab_orders';
            select = 'id, visit_id, test_name, test_code, urgency, status, result_value, reference_range, ordered_at, visits!inner(visit_date)';
        } else if (type === 'imaging') {
            table = 'imaging_orders';
            select = 'id, visit_id, study_name, urgency, status, findings, ordered_at, visits!inner(visit_date)';
        } else {
            table = 'medication_orders';
            select = 'id, visit_id, medication_name, dosage, frequency, status, ordered_at, visits!inner(visit_date)';
        }

        let query = supabaseAdmin
            .from(table)
            .select(select)
            .eq('patient_id', req.params.id)
            .order('ordered_at', { ascending: false })
            .limit(limit);

        if (excludeVisitId) {
            query = query.neq('visit_id', excludeVisitId);
        }
        if (facilityId) {
            query = query.eq('facility_id', facilityId);
        }
        if (tenantId) {
            query = query.eq('tenant_id', tenantId);
        }

        const { data, error } = await query;
        if (error) throw error;

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_order_history',
                eventType: 'read',
                entityType: table,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { type, result_count: (data || []).length },
            });
        }

        return res.json({ items: data || [] });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Failed to fetch order history' });
    }
});

/**
 * GET /api/patients/visits/:id/detail
 * Fetch patient detail bundle for a visit (visit, orders, payments, history, alerts)
 */
router.get('/visits/:id/detail', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    const visitId = req.params.id;

    try {
        const { data: visit, error: visitError } = await supabaseAdmin
            .from('visits')
            .select(`
	              *,
	              patients (*)
	            `)
            .eq('id', visitId)
            .maybeSingle();

        if (visitError) throw visitError;
        if (!visit) return res.status(404).json({ error: 'Visit not found' });

        if (facilityId && visit.facility_id !== facilityId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (tenantId && visit.tenant_id !== tenantId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const consentCheck = await maybeAssertProviderPhiConsentForPatient({
            tenantId,
            facilityId,
            patientId: visit.patient_id,
            consentType: PHI_PORTAL_CONSENT_TYPE,
        });
        if (consentCheck.ok === false) {
            return res.status(consentCheck.status).json({
                code: consentCheck.code,
                message: consentCheck.message,
            });
        }

        const vitals = visit.temperature || visit.blood_pressure || visit.heart_rate
            ? [{
                temperature: visit.temperature,
                blood_pressure: visit.blood_pressure,
                heart_rate: visit.heart_rate,
                respiratory_rate: visit.respiratory_rate,
                oxygen_saturation: visit.oxygen_saturation,
                recorded_at: visit.created_at,
            }]
            : [];

        const [labOrders, imagingOrders, medicationOrders] = await Promise.all([
            supabaseAdmin.from('lab_orders').select('*').eq('visit_id', visitId),
            supabaseAdmin.from('imaging_orders').select('*').eq('visit_id', visitId),
            supabaseAdmin.from('medication_orders').select('*').eq('visit_id', visitId),
        ]);

        if (labOrders.error) throw labOrders.error;
        if (imagingOrders.error) throw imagingOrders.error;
        if (medicationOrders.error) throw medicationOrders.error;

        const [billingItems, consultationFee] = await Promise.all([
            supabaseAdmin.from('billing_items').select('*').eq('visit_id', visitId),
            supabaseAdmin.from('visits').select('fee_paid, consultation_payment_type').eq('id', visitId).single(),
        ]);

        if (billingItems.error) throw billingItems.error;
        if (consultationFee.error) throw consultationFee.error;

        const paymentType = (visit as any).consultation_payment_type || 'paying';
        const isNonPayingPatient = ['free', 'credit', 'insured'].includes(paymentType);

        const totalLabDue = labOrders.data?.filter((o: any) => o.payment_status === 'unpaid')
            .reduce((sum: number, o: any) => sum + (o.amount || 0), 0) || 0;
        const totalImagingDue = imagingOrders.data?.filter((o: any) => o.payment_status === 'unpaid')
            .reduce((sum: number, o: any) => sum + (o.amount || 0), 0) || 0;
        const totalMedicationDue = medicationOrders.data?.filter((o: any) => o.payment_status === 'unpaid')
            .reduce((sum: number, o: any) => sum + (o.amount || 0), 0) || 0;

        const totalBillingDue = isNonPayingPatient ? 0 : (
            billingItems.data?.filter((b: any) => b.payment_status === 'unpaid')
                .reduce((sum: number, b: any) => sum + (b.total_amount || 0), 0) || 0
        );

        const payments = {
            totalDue: totalLabDue + totalImagingDue + totalMedicationDue + totalBillingDue,
            consultationPaid: isNonPayingPatient || (consultationFee.data as any)?.fee_paid > 0,
            consultationFee: (consultationFee.data as any)?.fee_paid || 0,
            consultationPaymentType: paymentType,
            labOrders: labOrders.data || [],
            imagingOrders: imagingOrders.data || [],
            medications: medicationOrders.data || [],
            billingItems: billingItems.data || [],
        };

        const { data: recentVisits } = await supabaseAdmin
            .from('visits')
            .select('*')
            .eq('patient_id', visit.patient_id)
            .neq('id', visitId)
            .order('visit_date', { ascending: false })
            .limit(5);

        const alerts: any[] = [];
        const latestVitals = vitals?.[0];
        if (latestVitals) {
            if (latestVitals.temperature && latestVitals.temperature > 38.5) {
                alerts.push({
                    id: 'high-temp',
                    severity: 'critical',
                    category: 'vitals',
                    message: `High temperature: ${latestVitals.temperature} C`,
                });
            }
            if (latestVitals.oxygen_saturation && latestVitals.oxygen_saturation < 95) {
                alerts.push({
                    id: 'low-o2',
                    severity: 'critical',
                    category: 'vitals',
                    message: `Low oxygen saturation: ${latestVitals.oxygen_saturation}%`,
                });
            }
        }

        if (payments.totalDue > 0) {
            alerts.push({
                id: 'unpaid',
                severity: 'warning',
                category: 'payment',
                message: `Outstanding balance: ${payments.totalDue} ETB`,
            });
        }

        if ((visit as any).triage_urgency === 'RED') {
            alerts.push({
                id: 'red-triage',
                severity: 'critical',
                category: 'triage',
                message: 'Emergency triage - requires immediate attention',
            });
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_visit_detail',
                eventType: 'read',
                entityType: 'visit',
                entityId: visitId,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
            });
        }

        return res.json({
            patient: (visit as any).patients,
            currentVisit: visit,
            vitalSigns: vitals || [],
            orders: {
                lab: labOrders.data || [],
                imaging: imagingOrders.data || [],
                medication: medicationOrders.data || [],
            },
            payments,
            history: {
                recentVisits: recentVisits || [],
                medicalHistory: null,
            },
            alerts,
        });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Failed to fetch patient detail' });
    }
});

/**
 * POST /api/patients/:id/visits
 * Create a new visit
 */
router.post('/:id/visits', async (req, res) => {
    const { tenantId, facilityId, profileId: userId, role } = req.user!;
    const patientId = req.params.id;

    try {
        const payload = createVisitSchema.parse(req.body);

        // 0. CHECK FOR ACTIVE VISITS
        const activeStatuses = [
            'registered',
            'triage',
            'doctor',
            'lab',
            'pharmacy',
            'procedure',
            'at_triage',
            'vitals_taken',
            'with_doctor',
            'at_lab',
            'at_imaging',
            'paying_consultation',
            'paying_diagnosis',
            'paying_pharmacy',
            'at_pharmacy',
        ];

        const { data: activeVisits } = await supabaseAdmin
            .from('visits')
            .select('id, status')
            .eq('patient_id', patientId)
            .in('status', activeStatuses)
            .order('visit_date', { ascending: false })
            .limit(1);

        if (activeVisits && activeVisits.length > 0) {
            return res.status(409).json({
                error: 'Patient has an active visit in progress. Please complete or cancel the existing visit before creating a new one.'
            });
        }

        await ensurePatientAccountLink({ patientId, tenantId });

        // 1. Insert Visit
        const { data: visit, error: visitError } = await supabaseAdmin
            .from('visits')
            .insert({
                patient_id: patientId,
                visit_date: payload.visitDate,
                reason: payload.reason,
                provider: payload.provider,
                fee_paid: payload.feePaid,
                visit_notes: payload.visitNotes || null,
                created_by: userId, // internal user id
                facility_id: facilityId,
                status: 'registered',
                tenant_id: tenantId
            })
            .select()
            .single();

        if (visitError) throw visitError;

        // 2. Initialize Journey Tracking
        await supabaseAdmin.rpc('append_journey_stage', {
            p_visit_id: visit.id,
            p_stage: 'registered',
            p_user_id: userId
        });

        // 3. Create Billing Item
        try {
            let consultationService;

            // Priority: Explicit Service ID
            if (payload.consultationServiceId && payload.consultationServiceId !== 'none') {
                const { data: selectedService } = await supabaseAdmin
                    .from('medical_services')
                    .select('id, price')
                    .eq('id', payload.consultationServiceId)
                    .single();

                if (selectedService) {
                    consultationService = selectedService;
                }
            }

            // Legacy Fallback (Only AND ONLY IF no explicit ID provided)
            // This is kept for backward compatibility with older clients if any, 
            // but we really want to move away from this.
            if (!consultationService && !payload.consultationServiceId) {
                const reasonLower = payload.reason.toLowerCase();
                const visitTypeKeyword = reasonLower.includes('new') ? 'new patient' :
                    reasonLower.includes('follow') ? 'follow-up' :
                        reasonLower.includes('emergency') ? 'emergency' :
                            'returning patient';

                // Try facility specific
                const { data: facService } = await supabaseAdmin
                    .from('medical_services')
                    .select('id, price')
                    .eq('facility_id', facilityId)
                    .eq('category', 'Consultation')
                    .eq('is_active', true)
                    .ilike('name', `%${visitTypeKeyword}%`)
                    .maybeSingle();

                consultationService = facService;

                // Fallback
                if (!consultationService) {
                    const { data: fallback } = await supabaseAdmin
                        .from('medical_services')
                        .select('id, price')
                        .eq('category', 'Consultation')
                        .eq('is_active', true)
                        .ilike('name', `%${visitTypeKeyword}%`)
                        .maybeSingle();
                    consultationService = fallback;
                }
            }

            if (consultationService) {
                await supabaseAdmin.from('billing_items').insert({
                    patient_id: patientId,
                    visit_id: visit.id,
                    service_id: consultationService.id,
                    quantity: 1,
                    unit_price: consultationService.price,
                    total_amount: consultationService.price,
                    created_by: userId,
                    payment_status: 'unpaid',
                    tenant_id: tenantId
                });
            }
        } catch (billingErr: any) {
            console.error('Billing creation failed', billingErr?.message || billingErr);
            // non-blocking
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'create_visit',
                eventType: 'create',
                entityType: 'visit',
                entityId: visit.id,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: userId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
            });
        }

        res.json(visit);

    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

// Schema for registration
const registerIntakeSchema = z.object({
    firstName: z.string(),
    middleName: z.string(),
    lastName: z.string(),
    sex: z.enum(['M', 'F']),
    age: z.number(),
    dateOfBirth: z.string().nullable().optional(),
    phone: z.string(),
    fayidaId: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    woredaSubcity: z.string().nullable().optional(),
    ketenaGott: z.string().nullable().optional(),
    kebele: z.string().nullable().optional(),
    houseNumber: z.string().nullable().optional(),
    visitType: z.string(),
    residence: z.string().nullable().optional(),
    occupation: z.string().nullable().optional(),
    intakeTimestamp: z.string(),
    intakePatientId: z.string(),
    consultationPaymentType: z.string(),
    programId: z.string().optional(),
    creditorId: z.string().optional(),
    insuranceProviderId: z.string().optional(),
    insurancePolicyNumber: z.string().optional(),

    // Intake flags
    isPregnant: z.boolean().optional(),
    emergencyFlag: z.boolean().optional(),
    emergencyDescription: z.string().optional(),
    guardianName: z.string().optional(),
    guardianPhone: z.string().optional(),
    guardianConsent: z.boolean().optional(),

    // Fee Selection
    consultationServiceId: z.string().optional(),

    // Requested Doctor
    requestedProfessionalId: z.string().optional()
});

const routeVisitSchema = z.object({
    destinationStage: z.string(),
    force: z.boolean().optional(),
});

/**
 * POST /api/patients/register-intake
 * Registers a new patient with visit and billing
 */
router.post('/register-intake', async (req, res) => {
    const { tenantId, facilityId, profileId: userId, role } = req.user!;

    try {
        const payload = registerIntakeSchema.parse(req.body);
        const normalizePaymentType = (value?: string) => {
            const normalized = (value || 'paying').trim().toLowerCase();
            if (normalized === 'digital') return 'paying';
            if (normalized === 'insurance') return 'insured';
            return normalized;
        };
        const consultationPaymentType = normalizePaymentType(payload.consultationPaymentType);
        const allowedPaymentTypes = new Set(['paying', 'free', 'credit', 'insured']);
        if (!allowedPaymentTypes.has(consultationPaymentType)) {
            return res.status(400).json({ error: 'Invalid consultation payment type' });
        }

        // 1. Duplicate Check (Fayida ID)
        if (payload.fayidaId) {
            const { data: existingPatient } = await supabaseAdmin
                .from('patients')
                .select('id')
                .eq('fayida_id', payload.fayidaId)
                .maybeSingle();

            if (existingPatient) {
                return res.status(409).json({ error: 'A patient with this National ID already exists.' });
            }
        }

        // 2. Call RPC
        const { data: result, error: rpcError } = await supabaseAdmin.rpc('register_patient_with_visit', {
            p_first_name: payload.firstName,
            p_middle_name: payload.middleName,
            p_last_name: payload.lastName,
            p_gender: payload.sex === 'M' ? 'Male' : 'Female',
            p_age: payload.age,
            p_date_of_birth: payload.dateOfBirth || null,
            p_phone: payload.phone,
            p_fayida_id: payload.fayidaId || null,
            p_user_id: userId,
            p_facility_id: facilityId,
            p_region: payload.region || null,
            p_woreda_subcity: payload.woredaSubcity || null,
            p_ketena_gott: payload.ketenaGott || null,
            p_kebele: payload.kebele || null,
            p_house_number: payload.houseNumber || null,
            p_visit_type: payload.visitType,
            p_residence: payload.residence || null,
            p_occupation: payload.occupation || null,
            p_intake_timestamp: payload.intakeTimestamp,
            p_intake_patient_id: payload.intakePatientId,
            p_consultation_payment_type: consultationPaymentType,
            p_program_id: payload.programId || null,
            p_creditor_id: payload.creditorId || null,
            p_insurer_id: payload.insuranceProviderId || null,
            p_insurance_policy_number: payload.insurancePolicyNumber || null,
            p_consultation_service_id: payload.consultationServiceId || null,
            p_provider: payload.requestedProfessionalId || 'Reception Intake'
        });

        if (rpcError) throw rpcError;

        const visitId = (result as { visit_id?: string } | null)?.visit_id;
        const patientId = (result as { patient_id?: string } | null)?.patient_id;

        if (patientId) {
            const fullName = [payload.firstName, payload.middleName, payload.lastName].filter(Boolean).join(' ').trim();
            await ensurePatientAccountLink({
                patientId,
                tenantId,
                phoneNumber: payload.phone,
                fullName: fullName || (result as { full_name?: string } | null)?.full_name || undefined,
                dateOfBirth: payload.dateOfBirth || null,
                gender: payload.sex === 'M' ? 'male' : 'female'
            });
        }

        // 3. Cleanup unexpected dressing charges (legacy data/trigger safety)
        if (visitId) {
            const { data: dressingServices } = await supabaseAdmin
                .from('medical_services')
                .select('id')
                .eq('facility_id', facilityId)
                .ilike('name', '%Dressing%');

            const dressingServiceIds = (dressingServices || []).map((service) => service.id);
            if (dressingServiceIds.length > 0) {
                await supabaseAdmin
                    .from('billing_items')
                    .delete()
                    .eq('visit_id', visitId)
                    .in('service_id', dressingServiceIds)
                    .in('payment_status', ['unpaid', 'pending']);
            }
        }

        // 4. Update visit notes with warnings/flags
        const intakeFlags: string[] = [];
        if (payload.visitType === 'Follow-up') {
            intakeFlags.push('Follow-up visit');
        }
        if (payload.age < 18) {
            intakeFlags.push(`Pediatric (${payload.age}y) guardian: ${payload.guardianName || 'n/a'} ${payload.guardianPhone || ''} consent: ${payload.guardianConsent ? 'yes' : 'no'}`.trim());
        }
        if (payload.isPregnant) {
            intakeFlags.push('Pregnancy flag recorded at intake');
        }
        if (payload.emergencyFlag) {
            intakeFlags.push(`Emergency flag: ${payload.emergencyDescription || 'unspecified'}`);
        }

        if (intakeFlags.length > 0 && visitId) {
            const note = `Intake flags — ${intakeFlags.join(' | ')}`;
            await supabaseAdmin
                .from('visits')
                .update({ visit_notes: note })
                .eq('id', visitId);
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'register_intake',
                eventType: 'create',
                entityType: 'patient',
                entityId: patientId || null,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: userId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { visit_id: visitId || null },
            });
        }

        res.json(result);

    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/patients/visits/:id/route
 * Route a visit to the next journey stage.
 */
router.post('/visits/:id/route', async (req, res) => {
    const { facilityId, profileId, role, tenantId } = req.user!;
    const visitId = req.params.id;

    try {
        const { destinationStage, force } = routeVisitSchema.parse(req.body);

        const { data: visitRow, error: visitError } = await supabaseAdmin
            .from('visits')
            .select('id, facility_id')
            .eq('id', visitId)
            .maybeSingle();

        if (visitError) throw visitError;
        if (!visitRow) return res.status(404).json({ error: 'Visit not found' });

        if (facilityId && visitRow.facility_id !== facilityId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { error: advanceError } = await supabaseAdmin.rpc('advance_patient_stage', {
            p_visit_id: visitId,
            p_next_stage: destinationStage,
            p_user_id: profileId || null,
        });

        if (!advanceError) {
            if (tenantId) {
                await recordAuditEvent({
                    action: 'route_visit',
                    eventType: 'update',
                    entityType: 'visit',
                    entityId: visitId,
                    tenantId,
                    facilityId: facilityId || null,
                    actorUserId: profileId || null,
                    actorRole: role || null,
                    actorIpAddress: req.ip,
                    actorUserAgent: req.get('user-agent') || null,
                    complianceTags: ['hipaa'],
                    sensitivityLevel: 'phi',
                    requestId: req.requestId || null,
                    metadata: { destination_stage: destinationStage, forced: false },
                });
            }

            return res.json({ success: true });
        }

        const canForce = force && ['admin', 'super_admin', 'finance'].includes(role);
        if (!canForce) {
            return res.status(400).json({ error: advanceError.message || 'Routing failed' });
        }

        const now = new Date().toISOString();
        const { error: updateError } = await supabaseAdmin
            .from('visits')
            .update({
                current_journey_stage: destinationStage,
                journey_stage: destinationStage,
                routing_status: 'routing_in_progress',
                status_updated_at: now,
            })
            .eq('id', visitId);

        if (updateError) throw updateError;

        if (tenantId) {
            await recordAuditEvent({
                action: 'route_visit',
                eventType: 'update',
                entityType: 'visit',
                entityId: visitId,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { destination_stage: destinationStage, forced: true },
            });
        }

        return res.json({ success: true, forced: true });
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message || 'Routing failed' });
    }
});

/**
 * POST /api/patients/visits/:id/stage
 * Append a journey stage without routing validation (audit logged).
 */
router.post('/visits/:id/stage', async (req, res) => {
    const { facilityId, profileId, role, tenantId } = req.user!;
    const visitId = req.params.id;

    try {
        const { stage } = appendStageSchema.parse(req.body);

        const { data: visitRow, error: visitError } = await supabaseAdmin
            .from('visits')
            .select('id, facility_id')
            .eq('id', visitId)
            .maybeSingle();

        if (visitError) throw visitError;
        if (!visitRow) return res.status(404).json({ error: 'Visit not found' });

        if (facilityId && visitRow.facility_id !== facilityId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { error: appendError } = await supabaseAdmin.rpc('append_journey_stage', {
            p_visit_id: visitId,
            p_stage: stage,
            p_user_id: profileId || null,
        });

        if (appendError) {
            return res.status(400).json({ error: appendError.message || 'Failed to append stage' });
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'append_journey_stage',
                eventType: 'update',
                entityType: 'visit',
                entityId: visitId,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { stage },
            });
        }

        return res.json({ success: true });
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        return res.status(500).json({ error: error.message || 'Failed to append stage' });
    }
});

export default router;
