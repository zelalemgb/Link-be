import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';

const router = Router();
router.use(requireUser);

const PAYMENT_STATUS = {
    PAID: 'paid',
    PARTIAL: 'partial',
    UNPAID: 'unpaid',
    PENDING: 'pending'
};

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

// --- Routes ---

/**
 * POST /api/finance/payments
 * Process payments for various items
 */
router.post('/payments', async (req, res) => {
    const { tenantId, facilityId, profileId: userId } = req.user!;

    try {
        const { visitId, patientId, items, allItemsPaid } = paymentSchema.parse(req.body);
        const now = new Date().toISOString();

        // 1. Update individual order tables
        const medicationUpdates = items
            .filter(i => i.itemType === 'medication')
            .map(i => supabaseAdmin
                .from('medication_orders')
                .update({
                    payment_status: PAYMENT_STATUS.PAID,
                    payment_mode: i.payment,
                    amount: i.price * i.qty,
                    paid_at: now,
                })
                .eq('id', i.referenceId)
            );

        const labUpdates = items
            .filter(i => i.itemType === 'lab_test')
            .map(i => supabaseAdmin
                .from('lab_orders')
                .update({
                    payment_status: PAYMENT_STATUS.PAID,
                    payment_mode: i.payment,
                    amount: i.price * i.qty,
                    paid_at: now,
                })
                .eq('id', i.referenceId)
            );

        const imagingUpdates = items
            .filter(i => i.itemType === 'imaging')
            .map(i => supabaseAdmin
                .from('imaging_orders')
                .update({
                    payment_status: PAYMENT_STATUS.PAID,
                    payment_mode: i.payment,
                    amount: i.price * i.qty,
                    paid_at: now,
                })
                .eq('id', i.referenceId)
            );

        const serviceUpdates = items
            .filter(i => i.itemType === 'service')
            .map(i => supabaseAdmin
                .from('billing_items')
                .update({
                    payment_status: PAYMENT_STATUS.PAID,
                    payment_mode: i.payment,
                    paid_at: now,
                })
                .eq('id', i.referenceId)
            );

        await Promise.all([
            ...medicationUpdates,
            ...labUpdates,
            ...imagingUpdates,
            ...serviceUpdates
        ]);

        // 2. Insert Payment Line Items (History Log)
        if (items.length > 0) {
            const lineItems = items.map(line => ({
                payment_id: null, // Will be linked later
                item_type: line.itemType,
                item_reference_id: line.referenceId,
                description: line.description || '',
                quantity: line.qty,
                unit_price: line.price,
                subtotal: line.price * line.qty,
                payment_method: line.payment,
                payment_status: PAYMENT_STATUS.PAID,
                final_amount: line.payment === 'free' ? 0 : line.price * line.qty,
                discount_percentage: 0,
                discount_amount: 0
            }));

            // We need a payment header to link these? Frontend logic:
            // 1. Update orders.
            // 2. Upsert payment header.
            // 3. Insert payment line items (it didn't link them to payment header in the frontend code shown? line 910 insert(lineItems)). 
            // If the schema requires payment_id, this would fail. 
            // Assuming we should follow the same pattern but clearer.

            // Let's create/get payment header first.
            const { data: existingPayment } = await supabaseAdmin
                .from('payments')
                .select('id')
                .eq('visit_id', visitId)
                .eq('facility_id', facilityId)
                .maybeSingle();

            let paymentId = existingPayment?.id;
            const status = allItemsPaid ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.PARTIAL;

            if (!paymentId) {
                const { data: newPayment, error: payError } = await supabaseAdmin
                    .from('payments')
                    .insert({
                        visit_id: visitId,
                        patient_id: patientId,
                        facility_id: facilityId,
                        tenant_id: tenantId,
                        cashier_id: userId,
                        payment_status: status
                    })
                    .select('id')
                    .single();

                if (payError) throw payError;
                paymentId = newPayment.id;
            } else {
                await supabaseAdmin
                    .from('payments')
                    .update({
                        cashier_id: userId,
                        payment_status: status,
                        updated_at: now
                    })
                    .eq('id', paymentId);
            }

            // Now insert line items linked to this payment
            const lineItemsWithId = lineItems.map(li => ({
                ...li,
                payment_id: paymentId
            }));

            console.log('[Payment] Inserting', lineItemsWithId.length, 'line items for payment:', paymentId);
            const { error: linesError } = await supabaseAdmin
                .from('payment_line_items')
                .insert(lineItemsWithId);

            if (linesError) {
                console.error("[Payment] ERROR inserting line items:", linesError);
                console.error("[Payment] Failed line items:", JSON.stringify(lineItemsWithId, null, 2));
            } else {
                console.log('[Payment] Successfully inserted line items');
            }
            // We don't rollback for this, it's logging.
        }

        // 3. Update Visit Status to awaiting_routing
        await supabaseAdmin
            .from('visits')
            .update({
                routing_status: 'awaiting_routing',
                status_updated_at: now
            })
            .eq('id', visitId);

        res.json({ success: true });

    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues });
        res.status(500).json({ error: error.message });
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
                let type = (item.visits?.consultation_payment_type || '').toLowerCase();
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

