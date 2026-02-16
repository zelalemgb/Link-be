import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../config/supabase';
import { requirePatientSession } from '../middleware/patient-auth';
import { recordAuditEvent } from '../services/audit-log';

const router = Router();
router.use(requirePatientSession);

const patientPortalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
});

/**
 * GET /api/mobile/patient/active-visit
 * Get the active visit for the authenticated patient
 */
router.get('/patient/active-visit', patientPortalLimiter, async (req, res) => {
    const { patientAccountId, tenantId } = req.patient!;

    try {
        let patientQuery = supabaseAdmin
            .from('patients')
            .select('id, full_name, first_name, last_name, phone, date_of_birth, gender, facility_id')
            .eq('patient_account_id', patientAccountId);

        if (tenantId) {
            patientQuery = patientQuery.eq('tenant_id', tenantId);
        }

        const { data: patients, error: patientError } = await patientQuery;
        if (patientError) throw patientError;
        if (!patients || patients.length === 0) {
            return res.json({ patient: null, activeVisit: null });
        }

        const patientIds = patients.map((patient) => patient.id);

        // Get active visit
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

        let visitQuery = supabaseAdmin
            .from('visits')
            .select(`
                id,
                patient_id,
                visit_date,
                reason,
                status,
                provider,
                created_at,
                temperature,
                blood_pressure,
                heart_rate,
                respiratory_rate,
                oxygen_saturation,
                triage_urgency
            `)
            .in('patient_id', patientIds)
            .in('status', activeStatuses)
            .order('visit_date', { ascending: false })
            .limit(1);

        if (tenantId) {
            visitQuery = visitQuery.eq('tenant_id', tenantId);
        }

        const { data: activeVisit, error: visitError } = await visitQuery.maybeSingle();
        if (visitError) throw visitError;

        const defaultPatient = patients[0];
        const patientData = activeVisit
            ? (patients.find((patient) => patient.id === activeVisit.patient_id) || defaultPatient)
            : defaultPatient;

        // If there's an active visit, get additional details
        let visitDetails = null;
        if (activeVisit) {
            const [labOrders, imagingOrders, medicationOrders] = await Promise.all([
                supabaseAdmin.from('lab_orders').select('id, test_name, status, payment_status').eq('visit_id', activeVisit.id),
                supabaseAdmin.from('imaging_orders').select('id, study_name, status, payment_status').eq('visit_id', activeVisit.id),
                supabaseAdmin.from('medication_orders').select('id, medication_name, status, payment_status').eq('visit_id', activeVisit.id),
            ]);

            visitDetails = {
                ...activeVisit,
                orders: {
                    lab: labOrders.data || [],
                    imaging: imagingOrders.data || [],
                    medication: medicationOrders.data || [],
                },
            };
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_active_visit',
                eventType: 'read',
                entityType: 'patient_portal',
                entityId: patientAccountId,
                tenantId,
                actorRole: 'patient',
                actorUserId: null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
            });
        }

        return res.json({
            patient: patientData,
            activeVisit: visitDetails,
        });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Failed to fetch active visit' });
    }
});

/**
 * GET /api/mobile/patient/stats
 * Get dashboard statistics for the authenticated patient
 */
router.get('/patient/stats', patientPortalLimiter, async (req, res) => {
    const { patientAccountId, tenantId } = req.patient!;

    try {
        // Get patient
        let patientQuery = supabaseAdmin
            .from('patients')
            .select('id')
            .eq('patient_account_id', patientAccountId);

        if (tenantId) {
            patientQuery = patientQuery.eq('tenant_id', tenantId);
        }

        const { data: patientRows, error: patientError } = await patientQuery;
        if (patientError) throw patientError;
        if (!patientRows || patientRows.length === 0) {
            return res.json({
                totalVisits: 0,
                activeTasks: 0,
                visitsToday: 0,
            });
        }

        const patientIds = patientRows.map((patient) => patient.id);

        // Get total visits
        let totalVisitQuery = supabaseAdmin
            .from('visits')
            .select('id', { count: 'exact', head: true })
            .in('patient_id', patientIds);

        if (tenantId) {
            totalVisitQuery = totalVisitQuery.eq('tenant_id', tenantId);
        }

        const { count: totalVisits } = await totalVisitQuery;

        // Get active tasks (unpaid orders)
        // First get all visit IDs for this patient to use in IN clause
        let patientVisitQuery = supabaseAdmin
            .from('visits')
            .select('id')
            .in('patient_id', patientIds);

        if (tenantId) {
            patientVisitQuery = patientVisitQuery.eq('tenant_id', tenantId);
        }

        const { data: patientVisits } = await patientVisitQuery;

        const visitIds = patientVisits?.map(v => v.id) || [];

        let activeTasks = 0;

        if (visitIds.length > 0) {
            const [labTasks, imagingTasks, medicationTasks] = await Promise.all([
                supabaseAdmin
                    .from('lab_orders')
                    .select('id', { count: 'exact', head: true })
                    .eq('payment_status', 'unpaid')
                    .in('visit_id', visitIds),
                supabaseAdmin
                    .from('imaging_orders')
                    .select('id', { count: 'exact', head: true })
                    .eq('payment_status', 'unpaid')
                    .in('visit_id', visitIds),
                supabaseAdmin
                    .from('medication_orders')
                    .select('id', { count: 'exact', head: true })
                    .eq('payment_status', 'unpaid')
                    .in('visit_id', visitIds),
            ]);

            activeTasks = (labTasks.count || 0) + (imagingTasks.count || 0) + (medicationTasks.count || 0);
        }

        // Get visits today
        const today = new Date().toISOString().split('T')[0];
        let visitsTodayQuery = supabaseAdmin
            .from('visits')
            .select('id', { count: 'exact', head: true })
            .in('patient_id', patientIds)
            .gte('visit_date', today);

        if (tenantId) {
            visitsTodayQuery = visitsTodayQuery.eq('tenant_id', tenantId);
        }

        const { count: visitsToday } = await visitsTodayQuery;

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_stats',
                eventType: 'read',
                entityType: 'patient_portal',
                entityId: patientAccountId,
                tenantId,
                actorRole: 'patient',
                actorUserId: null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
            });
        }

        return res.json({
            totalVisits: totalVisits || 0,
            activeTasks,
            visitsToday: visitsToday || 0,
        });
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Failed to fetch patient stats' });
    }
});

/**
 * GET /api/mobile/patient/visit-history
 * Get visit history for the authenticated patient
 */
router.get('/patient/visit-history', patientPortalLimiter, async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 10;
    const { patientAccountId, tenantId } = req.patient!;

    try {
        // Get patient
        let patientQuery = supabaseAdmin
            .from('patients')
            .select('id')
            .eq('patient_account_id', patientAccountId);

        if (tenantId) {
            patientQuery = patientQuery.eq('tenant_id', tenantId);
        }

        const { data: patientRows, error: patientError } = await patientQuery;
        if (patientError) throw patientError;
        if (!patientRows || patientRows.length === 0) {
            return res.json([]);
        }

        const patientIds = patientRows.map((patient) => patient.id);

        let visitsQuery = supabaseAdmin
            .from('visits')
            .select('id, visit_date, reason, status, provider')
            .in('patient_id', patientIds)
            .order('visit_date', { ascending: false })
            .limit(limit);

        if (tenantId) {
            visitsQuery = visitsQuery.eq('tenant_id', tenantId);
        }

        const { data: visits, error } = await visitsQuery;
        if (error) throw error;

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_visit_history',
                eventType: 'read',
                entityType: 'patient_portal',
                entityId: patientAccountId,
                tenantId,
                actorRole: 'patient',
                actorUserId: null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
            });
        }

        return res.json(visits || []);
    } catch (error: any) {
        return res.status(500).json({ error: error.message || 'Failed to fetch visit history' });
    }
});

export default router;
