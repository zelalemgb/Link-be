import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { processPayment, type PaymentItem } from '../services/financeService';
import {
    fetchAwaitingRoutingPatients,
    fetchDailyCollections,
    fetchPaidPatients,
    fetchPendingBills,
} from '../services/cashierDataService';
import { recordAuditEvent } from '../services/audit-log';

const router = Router();
router.use(requireUser, requireScopedUser);
const isFinanceDebug = process.env.FINANCE_DEBUG === 'true';

// --- Schemas ---

const itemSchema = z.object({
    referenceId: z.string(),
    itemType: z.enum(['medication', 'lab_test', 'imaging', 'service']),
    price: z.number(),
    qty: z.number(),
    payment: z.string(), // "cash", "insurance", "credit", "free"
    description: z.string().optional(),
});

const paymentSchema = z.object({
    visitId: z.string(),
    patientId: z.string(),
    items: z.array(itemSchema),
    allItemsPaid: z.boolean(),
});

const externalOrderSchema = z.object({
    items: z.array(z.object({
        referenceId: z.string(),
        itemType: z.enum(['lab_test', 'imaging']),
    })),
});

const visitPaymentStatusSchema = z.object({
    visitId: z.string(),
});

const quickServiceSchema = z.object({
    items: z.array(z.object({
        serviceId: z.string(),
        category: z.string(),
        description: z.string(),
        quantity: z.number(),
        unitPrice: z.number(),
        total: z.number(),
        paymentType: z.enum(['cash', 'credit', 'insured', 'free']),
        insuranceProvider: z.string().optional().nullable(),
    })),
    visitId: z.string().optional().nullable(),
    patientId: z.string().optional().nullable(),
});

const billingBatchSchema = z.object({
    visitId: z.string().uuid(),
    patientId: z.string().uuid(),
    items: z.array(z.object({
        serviceId: z.string().uuid(),
        quantity: z.number().positive(),
        unitPrice: z.number().min(0),
        totalAmount: z.number().min(0),
        notes: z.string().optional().nullable(),
    })).min(1),
});

// --- Routes ---

/**
 * POST /api/finance/payments
 * Process payments for various items
 */
router.post('/payments', async (req, res) => {
    const { tenantId, facilityId, profileId: userId, role } = req.user!;
    if (!tenantId || !facilityId || !userId) {
        return res.status(403).json({ error: 'Missing tenant or facility context' });
    }

    try {
        const parsed = paymentSchema.parse(req.body);
        const items = parsed.items as PaymentItem[];
        const { visitId, patientId, allItemsPaid } = parsed;
        const response = await processPayment({
            visitId,
            patientId,
            items,
            allItemsPaid,
            tenantId,
            facilityId,
            userId,
        });

        if (tenantId) {
            await recordAuditEvent({
                action: 'process_payment',
                eventType: 'create',
                entityType: 'payment',
                entityId: parsed.visitId,
                tenantId,
                facilityId,
                actorUserId: userId,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { item_count: items.length, all_items_paid: allItemsPaid },
            });
        }

        res.json(response);

    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message || 'Payment processing failed' });
    }
});

router.post('/billing-items/batch', async (req, res) => {
    const { tenantId, facilityId, profileId: userId, role } = req.user!;
    if (!tenantId || !facilityId || !userId) {
        return res.status(403).json({ error: 'Missing tenant or facility context' });
    }

    try {
        const parsed = billingBatchSchema.parse(req.body);
        const { visitId, patientId, items } = parsed;

        const { data: visit, error: visitError } = await supabaseAdmin
            .from('visits')
            .select('id, facility_id, tenant_id, patient_id')
            .eq('id', visitId)
            .maybeSingle();

        if (visitError) throw visitError;
        if (!visit) return res.status(404).json({ error: 'Visit not found' });
        if (visit.facility_id !== facilityId || visit.tenant_id !== tenantId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (visit.patient_id !== patientId) {
            return res.status(400).json({ error: 'Visit/patient mismatch' });
        }

        const rows = items.map((item) => ({
            visit_id: visitId,
            tenant_id: tenantId,
            patient_id: patientId,
            service_id: item.serviceId,
            quantity: item.quantity,
            unit_price: item.unitPrice,
            total_amount: item.totalAmount,
            created_by: userId,
            payment_status: 'unpaid',
            notes: item.notes || null,
        }));

        const { error: insertError } = await supabaseAdmin
            .from('billing_items')
            .insert(rows as any);
        if (insertError) throw insertError;

        await recordAuditEvent({
            action: 'create_billing_items_batch',
            eventType: 'create',
            entityType: 'billing_item',
            entityId: visitId,
            tenantId,
            facilityId,
            actorUserId: userId,
            actorRole: role || null,
            actorIpAddress: req.ip,
            actorUserAgent: req.get('user-agent') || null,
            complianceTags: ['hipaa'],
            sensitivityLevel: 'phi',
            requestId: req.requestId || null,
            metadata: { item_count: rows.length },
        });

        return res.json({ inserted: rows.length });
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        return res.status(500).json({ error: error.message || 'Failed to create billing items' });
    }
});

/**
 * GET /api/finance/visits/count
 * Count visits for the current facility with optional start date (ISO).
 */
router.get('/visits/count', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    const from = req.query.from as string | undefined;

    try {
        let query = supabaseAdmin
            .from('visits')
            .select('*', { count: 'exact', head: true })
            .eq('facility_id', facilityId);

        if (from) {
            query = query.gte('created_at', from);
        }

        const { count, error } = await query;
        if (error) throw error;

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_visit_count',
                eventType: 'read',
                entityType: 'visit_metrics',
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { count: count ?? 0 },
            });
        }

        res.json({ count: count ?? 0 });
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch visit count' });
    }
});

router.get('/metrics', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }

    try {
        const today = new Date().toISOString().split('T')[0];
        const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const { data: todayBilling, error: todayError } = await supabaseAdmin
            .from('billing_items')
            .select('total_amount, visits!inner(facility_id)')
            .eq('visits.facility_id', facilityId)
            .gte('created_at', today);

        if (todayError) throw todayError;

        const todayRevenue =
            todayBilling?.reduce((sum, item: any) => sum + Number(item.total_amount || 0), 0) || 0;

        const { data: weeklyBilling, error: weeklyError } = await supabaseAdmin
            .from('billing_items')
            .select('total_amount, visits!inner(facility_id)')
            .eq('visits.facility_id', facilityId)
            .gte('created_at', lastWeek);

        if (weeklyError) throw weeklyError;

        const weeklyRevenue =
            weeklyBilling?.reduce((sum, item: any) => sum + Number(item.total_amount || 0), 0) || 0;

        const outstandingBills = todayRevenue * 0.3;
        const collectionRate = todayRevenue > 0 ? ((todayRevenue - outstandingBills) / todayRevenue) * 100 : 0;

        const { data: visits, error: visitsError } = await supabaseAdmin
            .from('visits')
            .select('id')
            .eq('facility_id', facilityId)
            .gte('visit_date', lastWeek);

        if (visitsError) throw visitsError;

        const visitCount = visits?.length || 1;

        const { data: stock, error: stockError } = await supabaseAdmin
            .from('stock_movements')
            .select('total_cost')
            .eq('facility_id', facilityId)
            .gte('created_at', lastWeek)
            .eq('movement_type', 'dispensing');

        if (stockError) throw stockError;

        const medicationCosts =
            stock?.reduce((sum, item: any) => sum + (Number(item.total_cost) || 0), 0) || 0;

        const costPerVisit = weeklyRevenue > 0 ? medicationCosts / visitCount : 0;

        const paymentMix = {
            cash: 65,
            insurance: 20,
            credit: 15,
        };

        const budgetAlerts = costPerVisit > weeklyRevenue / visitCount ? 1 : 0;

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_finance_metrics',
                eventType: 'read',
                entityType: 'finance_metrics',
                tenantId,
                facilityId,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
            });
        }

        res.json({
            todayRevenue: Math.round(todayRevenue),
            weeklyRevenue: Math.round(weeklyRevenue),
            outstandingBills: Math.round(outstandingBills),
            collectionRate: Math.round(collectionRate),
            costPerVisit: Math.round(costPerVisit),
            medicationCosts: Math.round(medicationCosts),
            paymentMix,
            budgetAlerts,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch finance metrics' });
    }
});

router.get('/ceo-metrics', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }

    try {
        const today = new Date().toISOString().split('T')[0];
        const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const { data: billing, error: billingError } = await supabaseAdmin
            .from('billing_items')
            .select('total_amount, created_at, visits!inner(facility_id)')
            .eq('visits.facility_id', facilityId)
            .gte('created_at', today);

        if (billingError) throw billingError;

        const todayRevenue = billing?.reduce((sum, item: any) => sum + Number(item.total_amount || 0), 0) || 0;

        const { data: monthlyBilling, error: monthlyError } = await supabaseAdmin
            .from('billing_items')
            .select('total_amount, visits!inner(facility_id)')
            .eq('visits.facility_id', facilityId)
            .gte('created_at', lastMonth);

        if (monthlyError) throw monthlyError;

        const monthlyRevenue = monthlyBilling?.reduce((sum, item: any) => sum + Number(item.total_amount || 0), 0) || 0;

        const { data: visitsToday, error: visitsTodayError } = await supabaseAdmin
            .from('visits')
            .select('id, created_at, status_updated_at, status, visit_date')
            .eq('facility_id', facilityId)
            .eq('visit_date', today);

        if (visitsTodayError) throw visitsTodayError;

        const patientsToday = visitsToday?.length || 0;

        const { data: monthlyVisits, error: monthlyVisitsError } = await supabaseAdmin
            .from('visits')
            .select('id')
            .eq('facility_id', facilityId)
            .gte('visit_date', lastMonth);

        if (monthlyVisitsError) throw monthlyVisitsError;

        const patientThroughput = monthlyVisits?.length || 0;

        const completedVisits = visitsToday?.filter((v: any) => v.status !== 'waiting' && v.status_updated_at) || [];
        const avgWaitTime = completedVisits.length > 0
            ? completedVisits.reduce((sum: number, v: any) => {
                const wait = (new Date(v.status_updated_at).getTime() - new Date(v.created_at).getTime()) / 60000;
                return sum + wait;
            }, 0) / completedVisits.length
            : 0;

        const { data: stock, error: stockError } = await supabaseAdmin
            .from('current_stock')
            .select('current_quantity, reorder_level')
            .eq('facility_id', facilityId)
            .lt('current_quantity', 'reorder_level');

        if (stockError) throw stockError;

        const criticalStockItems = stock?.length || 0;

        const { data: staff, error: staffError } = await supabaseAdmin
            .from('users')
            .select('id, user_role')
            .eq('facility_id', facilityId)
            .neq('user_role', 'super_admin');

        if (staffError) throw staffError;

        const totalStaff = staff?.length || 0;
        const staffPresent = Math.floor(totalStaff * 0.85);
        const staffProductivity = patientsToday > 0 ? patientsToday / (staffPresent || 1) : 0;

        const activePatients = visitsToday?.filter((v: any) => v.status === 'in_progress').length || 0;
        const bedOccupancy = Math.min((activePatients / 50) * 100, 100);
        const bedUtilization = Math.round((bedOccupancy / 100) * (staffPresent / (totalStaff || 1)) * 100);

        const revenuePerPatient = patientsToday > 0 ? todayRevenue / patientsToday : 0;
        const estimatedCosts = monthlyRevenue * 0.65;
        const profitMargin = monthlyRevenue > 0 ? ((monthlyRevenue - estimatedCosts) / monthlyRevenue) * 100 : 0;
        const costPerPatient = patientThroughput > 0 ? estimatedCosts / patientThroughput : 0;
        const operatingCostRatio = monthlyRevenue > 0 ? (estimatedCosts / monthlyRevenue) * 100 : 0;

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_ceo_metrics',
                eventType: 'read',
                entityType: 'finance_metrics',
                tenantId,
                facilityId,
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
            todayRevenue,
            revenueTarget: 50000,
            profitMargin: Math.round(profitMargin * 10) / 10,
            revenuePerPatient: Math.round(revenuePerPatient),
            avgWaitTime: Math.round(avgWaitTime),
            bedOccupancy: Math.round(bedOccupancy),
            bedUtilization,
            patientThroughput,
            criticalStockItems,
            inventoryTurnover: 12,
            staffPresent,
            totalStaff,
            staffProductivity: Math.round(staffProductivity * 10) / 10,
            patientsToday,
            patientSatisfaction: 4.2,
            readmissionRate: 3.2,
            avgLengthOfStay: 2.5,
            costPerPatient: Math.round(costPerPatient),
            operatingCostRatio: Math.round(operatingCostRatio * 10) / 10,
            facilityId,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch CEO metrics' });
    }
});

router.get('/cashier/pending', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    try {
        const patients = await fetchPendingBills(facilityId);
        if (tenantId) {
            await recordAuditEvent({
                action: 'view_cashier_pending',
                eventType: 'read',
                entityType: 'billing_queue',
                tenantId,
                facilityId,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { result_count: (patients as any[])?.length || 0 },
            });
        }

        res.json(patients);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch pending bills' });
    }
});

router.get('/cashier/paid', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    try {
        const patients = await fetchPaidPatients(facilityId);
        if (tenantId) {
            await recordAuditEvent({
                action: 'view_cashier_paid',
                eventType: 'read',
                entityType: 'billing_queue',
                tenantId,
                facilityId,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { result_count: (patients as any[])?.length || 0 },
            });
        }

        res.json(patients);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch paid patients' });
    }
});

router.get('/cashier/collections', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    try {
        const collections = await fetchDailyCollections(facilityId);
        if (tenantId) {
            await recordAuditEvent({
                action: 'view_cashier_collections',
                eventType: 'read',
                entityType: 'collections',
                tenantId,
                facilityId,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { total_collections: collections?.total || 0 },
            });
        }

        res.json(collections);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch collections' });
    }
});

router.get('/cashier/awaiting-routing', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    try {
        const patients = await fetchAwaitingRoutingPatients(facilityId);
        if (tenantId) {
            await recordAuditEvent({
                action: 'view_cashier_awaiting_routing',
                eventType: 'read',
                entityType: 'billing_queue',
                tenantId,
                facilityId,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { result_count: (patients as any[])?.length || 0 },
            });
        }

        res.json(patients);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch routing queue' });
    }
});

router.get('/visits/active', async (req, res) => {
    const { facilityId, tenantId, profileId, role } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    const fromDate = req.query.from as string | undefined;
    try {
        let query = supabaseAdmin
            .from('visits')
            .select('id, created_at, status, status_updated_at, journey_timeline')
            .eq('facility_id', facilityId);

        if (fromDate) {
            query = query.gte('visit_date', fromDate);
        }

        const { data, error } = await query;
        if (error) throw error;
        if (tenantId) {
            await recordAuditEvent({
                action: 'view_active_visits',
                eventType: 'read',
                entityType: 'visit_list',
                tenantId,
                facilityId,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { result_count: (data || []).length },
            });
        }

        res.json(data || []);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch visits' });
    }
});

/**
 * GET /api/finance/visits/:id/payment-status
 * Summary of unpaid items for reception displays.
 */
router.get('/visits/:id/payment-status', async (req, res) => {
    const { tenantId, facilityId, profileId, role } = req.user!;
    const parsed = visitPaymentStatusSchema.safeParse({ visitId: req.params.id });
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid visit id' });
    }

    try {
        const visitId = parsed.data.visitId;
        const { data: medications, error: medError } = await supabaseAdmin
            .from('medication_orders')
            .select('id, amount')
            .eq('visit_id', visitId)
            .eq('payment_status', 'unpaid');

        if (medError) throw medError;

        const { data: labs, error: labError } = await supabaseAdmin
            .from('lab_orders')
            .select('id, amount')
            .eq('visit_id', visitId)
            .eq('payment_status', 'unpaid');

        if (labError) throw labError;

        const { data: imaging, error: imgError } = await supabaseAdmin
            .from('imaging_orders')
            .select('id, amount')
            .eq('visit_id', visitId)
            .eq('payment_status', 'unpaid');

        if (imgError) throw imgError;

        const { data: billingItems, error: billError } = await supabaseAdmin
            .from('billing_items')
            .select('id, total_amount')
            .eq('visit_id', visitId)
            .eq('payment_status', 'unpaid');

        if (billError) throw billError;

        const { data: visit, error: visitError } = await supabaseAdmin
            .from('visits')
            .select('fee_paid, consultation_payment_type')
            .eq('id', visitId)
            .single();

        if (visitError) throw visitError;

        const medTotal = medications?.reduce((sum, med) => sum + (med.amount || 0), 0) || 0;
        const labTotal = labs?.reduce((sum, lab) => sum + (lab.amount || 0), 0) || 0;
        const imgTotal = imaging?.reduce((sum, img) => sum + (img.amount || 0), 0) || 0;
        const billTotalRaw = billingItems?.reduce((sum, bill) => sum + (bill.total_amount || 0), 0) || 0;

        const paymentType = (visit as any)?.consultation_payment_type || 'paying';
        const isNonPaying = ['free', 'credit', 'insured'].includes(paymentType);
        const billTotal = isNonPaying ? 0 : billTotalRaw;

        const totalDue = medTotal + labTotal + imgTotal + billTotal;
        const hasUnpaidItems = totalDue > 0;
        const billingCount = isNonPaying ? 0 : (billingItems?.length || 0);
        const unpaidItemsCount = (medications?.length || 0) + (labs?.length || 0) + (imaging?.length || 0) + billingCount;

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_payment_status',
                eventType: 'read',
                entityType: 'visit_payment_status',
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
            hasUnpaidItems,
            totalDue,
            consultationFeePaid: visit?.fee_paid || 0,
            unpaidItemsCount,
            unpaidBreakdown: {
                medications: medTotal,
                labs: labTotal,
                imaging: imgTotal,
                billing: billTotal,
            },
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch payment status' });
    }
});

/**
 * POST /api/finance/orders/external
 * Mark orders as sent outside
 */
router.post('/orders/external', async (req, res) => {
    const { tenantId, facilityId, profileId, role } = req.user!;
    try {
        const { items } = externalOrderSchema.parse(req.body);
        const now = new Date().toISOString();

        for (const item of items) {
            if (item.itemType === 'lab_test') {
                await supabaseAdmin
                    .from('lab_orders')
                    .update({
                        sent_outside: true,
                        notes: `Sent to external lab - ${now}`
                    })
                    .eq('id', item.referenceId);
            } else if (item.itemType === 'imaging') {
                await supabaseAdmin
                    .from('imaging_orders')
                    .update({
                        sent_outside: true,
                        notes: `Sent to external facility - ${now}`
                    })
                    .eq('id', item.referenceId);
            }
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'mark_orders_external',
                eventType: 'update',
                entityType: 'order',
                tenantId,
                facilityId: facilityId || null,
                actorUserId: profileId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { item_count: items.length },
            });
        }

        res.json({ success: true, count: items.length });

    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});


/**
 * GET /api/finance/daily-summary
 * Get expected total for the current cashier today
 */
router.get('/daily-summary', async (req, res) => {
    const { profileId: userId, facilityId, tenantId, role } = req.user!;

    try {
        // Query payment line items linked to payments made by this cashier today
        // Use DATE() function to avoid timezone issues
        const { data, error } = await supabaseAdmin
            .from('payment_line_items')
            .select(`
                final_amount,
                payment_method,
                payments!inner (
                    facility_id,
                    payment_status,
                    created_at
                )
            `)
            .eq('payments.facility_id', facilityId)
            .eq('payments.payment_status', 'paid')
            .gte('payments.created_at', new Date().toISOString().split('T')[0]); // Use YYYY-MM-DD format

        if (error) {
            console.error('[DailySummary] Payment Query Error:', error?.message || error);
            throw error;
        }
        if (isFinanceDebug) {
            console.log('[DailySummary] Paid Items Found:', data?.length || 0);
        }

        // Calculate total - Only include liquid payments (Cash/Digital)
        // Excluding Insurance and Credit which are AR
        const liquidMethods = ['cash', 'paying', 'mobile_money', 'card', 'digital', 'check', 'cheque', 'free', 'credit', 'insured'];

        const breakdown: Record<string, number> = {};
        liquidMethods.forEach(m => breakdown[m] = 0);

        let expectedTotal = 0;

        // 1. Process Paid Items (from payment_line_items)
        data.forEach(item => {
            const method = (item.payment_method || '').toLowerCase();
            const amount = item.final_amount || 0;

            if (liquidMethods.includes(method)) {
                breakdown[method] = (breakdown[method] || 0) + amount;

                // Only Cash and Digital count towards Expected Total (Liquidity)
                if (['cash', 'paying', 'mobile_money', 'card', 'digital', 'check', 'cheque'].includes(method)) {
                    expectedTotal += amount;
                }
            }
        });

        // 2. Process Unpaid/Pending Items from Today's Registration (User's activity)
        // This covers the case where Reception registers but "Cashier Payment" isn't clicked yet.
        // We assume "paying" type means "Cash".
        const { data: pendingItems, error: pendingError } = await supabaseAdmin
            .from('billing_items')
            .select(`
                total_amount,
                visits!inner (
                    consultation_payment_type
                )
            `)
            .eq('visits.facility_id', facilityId)
            .eq('payment_status', 'unpaid')
            .gte('created_at', new Date().toISOString().split('T')[0]);

        if (!pendingError && pendingItems) {
            if (isFinanceDebug) {
                console.log('[DailySummary] Pending Unpaid Items Found:', pendingItems.length);
            }
            pendingItems.forEach(item => {
                const visit = Array.isArray(item.visits) ? item.visits[0] : item.visits;
                let type = (visit?.consultation_payment_type || '').toLowerCase();
                const amount = item.total_amount || 0;

                // Map 'paying' to 'cash' for consistency if needed, or keep as 'paying'
                // The frontend maps 'paying' -> 'Cash' label.

                if (liquidMethods.includes(type)) {
                    breakdown[type] = (breakdown[type] || 0) + amount;

                    // If it's liquid (Cash/Digital), we expect it in the drawer/account
                    if (['cash', 'paying', 'mobile_money', 'card', 'digital', 'check', 'cheque'].includes(type)) {
                        expectedTotal += amount;
                    }
                }
            });
        }

        if (isFinanceDebug) {
            console.log('[DailySummary] Final response:', { expectedTotal, breakdown });
        }

        if (tenantId) {
            await recordAuditEvent({
                action: 'view_daily_summary',
                eventType: 'read',
                entityType: 'daily_summary',
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

        res.json({ expectedTotal, breakdown });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

const closeDaySchema = z.object({
    expectedTotal: z.number(),
    cashCollected: z.number(),
    digitalCollected: z.number(),
    variance: z.number(),
    reason: z.enum(['Change', 'Waiver', 'Error', 'Pending']).nullable(),
    notes: z.string().optional().nullable(),
});

/**
 * POST /api/finance/close-day
 * Submit daily reconciliation
 */
router.post('/close-day', async (req, res) => {
    const { tenantId, facilityId, profileId: userId, role } = req.user!;

    try {
        const body = closeDaySchema.parse(req.body);

        if (body.variance !== 0 && !body.reason) {
            return res.status(400).json({ error: 'Reason is required when there is a variance.' });
        }

        const { error } = await supabaseAdmin
            .from('finance_reconciliations')
            .insert({
                facility_id: facilityId,
                tenant_id: tenantId,
                cashier_id: userId,
                expected_total: body.expectedTotal,
                cash_collected: body.cashCollected,
                digital_collected: body.digitalCollected,
                variance: body.variance,
                reason: body.reason,
                notes: body.notes
            });

        if (error) throw error;

        if (tenantId) {
            await recordAuditEvent({
                action: 'close_day',
                eventType: 'create',
                entityType: 'finance_reconciliation',
                tenantId,
                facilityId: facilityId || null,
                actorUserId: userId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { variance: body.variance, reason: body.reason || null },
            });
        }

        res.json({ success: true });
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/finance/quick-service
 * Create a payment + line items for quick service entries
 */
router.post('/quick-service', async (req, res) => {
    const { tenantId, facilityId, profileId: userId, role } = req.user!;

    if (!tenantId || !facilityId || !userId) {
        return res.status(403).json({ error: 'Missing tenant or facility context' });
    }

    try {
        const parsed = quickServiceSchema.parse(req.body);
        const { items, visitId, patientId } = parsed;

        const totalAmount = items.reduce((sum, item) => sum + item.total, 0);
        const cashAmount = items.filter((i) => i.paymentType === 'cash').reduce((sum, i) => sum + i.total, 0);
        const dueAmount = items.filter((i) => i.paymentType !== 'free').reduce((sum, i) => sum + i.total, 0);

        const { data: paymentData, error: paymentError } = await supabaseAdmin
            .from('payments')
            .insert({
                tenant_id: tenantId,
                facility_id: facilityId,
                patient_id: patientId || '',
                visit_id: visitId || '',
                total_amount: totalAmount,
                amount_paid: cashAmount,
                amount_due: dueAmount,
                payment_status: cashAmount >= totalAmount ? 'paid' : cashAmount > 0 ? 'partial' : 'pending',
                cashier_id: userId,
            })
            .select()
            .single();

        if (paymentError) throw paymentError;

        const lineItems = items.map((item) => ({
            payment_id: paymentData.id,
            item_type: item.category,
            description: item.description,
            unit_price: item.unitPrice,
            quantity: item.quantity,
            subtotal: item.total,
            final_amount: item.total,
            payment_method: item.paymentType,
            payment_status: item.paymentType === 'free' ? 'paid' : 'pending',
            insurance_provider: item.insuranceProvider || null,
        }));

        const { error: lineItemsError } = await supabaseAdmin
            .from('payment_line_items')
            .insert(lineItems);

        if (lineItemsError) throw lineItemsError;

        if (tenantId) {
            await recordAuditEvent({
                action: 'quick_service_payment',
                eventType: 'create',
                entityType: 'payment',
                entityId: paymentData.id,
                tenantId,
                facilityId: facilityId || null,
                actorUserId: userId || null,
                actorRole: role || null,
                actorIpAddress: req.ip,
                actorUserAgent: req.get('user-agent') || null,
                complianceTags: ['hipaa'],
                sensitivityLevel: 'phi',
                requestId: req.requestId || null,
                metadata: { item_count: lineItems.length },
            });
        }

        res.json({ success: true, paymentId: paymentData.id, items: lineItems.length });
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message || 'Failed to process quick service payment' });
    }
});

export default router;
