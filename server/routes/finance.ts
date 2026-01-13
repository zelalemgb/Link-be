import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';
import { processPayment, type PaymentItem } from '../services/financeService';
import {
    fetchAwaitingRoutingPatients,
    fetchDailyCollections,
    fetchPaidPatients,
    fetchPendingBills,
} from '../services/cashierDataService';

const router = Router();
router.use(requireUser);

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

// --- Routes ---

/**
 * POST /api/finance/payments
 * Process payments for various items
 */
router.post('/payments', async (req, res) => {
    const { tenantId, facilityId, profileId: userId } = req.user!;
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

        res.json(response);

    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message || 'Payment processing failed' });
    }
});

/**
 * GET /api/finance/visits/count
 * Count visits for the current facility with optional start date (ISO).
 */
router.get('/visits/count', async (req, res) => {
    const { facilityId } = req.user!;
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

        res.json({ count: count ?? 0 });
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch visit count' });
    }
});

router.get('/cashier/pending', async (req, res) => {
    const { facilityId } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    try {
        const patients = await fetchPendingBills(facilityId);
        res.json(patients);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch pending bills' });
    }
});

router.get('/cashier/paid', async (req, res) => {
    const { facilityId } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    try {
        const patients = await fetchPaidPatients(facilityId);
        res.json(patients);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch paid patients' });
    }
});

router.get('/cashier/collections', async (req, res) => {
    const { facilityId } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    try {
        const collections = await fetchDailyCollections(facilityId);
        res.json(collections);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch collections' });
    }
});

router.get('/cashier/awaiting-routing', async (req, res) => {
    const { facilityId } = req.user!;
    if (!facilityId) {
        return res.status(403).json({ error: 'Missing facility context' });
    }
    try {
        const patients = await fetchAwaitingRoutingPatients(facilityId);
        res.json(patients);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Unable to fetch routing queue' });
    }
});

router.get('/visits/active', async (req, res) => {
    const { facilityId } = req.user!;
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
    const { profileId: userId, facilityId } = req.user!;

    try {
        // Query payment line items linked to payments made by this cashier today
        // Use DATE() function to avoid timezone issues
        console.log('[DailySummary] FacilityId:', facilityId, 'UserId:', userId);
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
            console.error('[DailySummary] Payment Query Error:', error);
            throw error;
        }
        console.log('[DailySummary] Paid Items Found:', data?.length);
        if (data && data.length > 0) {
            console.log('[DailySummary] Sample item:', JSON.stringify(data[0], null, 2));
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
            console.log('[DailySummary] Pending Unpaid Items Found:', pendingItems.length);
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


        console.log('[DailySummary] Final response:', { expectedTotal, breakdown });

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
    const { tenantId, facilityId, profileId: userId } = req.user!;

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

        res.json({ success: true });
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
    }
});

export default router;
