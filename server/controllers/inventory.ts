
import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { z } from 'zod';
import { isAuditDurabilityError, recordAuditEvent } from '../services/audit-log.js';

const isInventoryDebug = process.env.INVENTORY_DEBUG === 'true';
const sendContractError = (res: Response, status: number, code: string, message: string) =>
    res.status(status).json({ code, message });

// --- Schemas ---
const createItemSchema = z.object({
    name: z.string().min(2),
    generic_name: z.string().optional(),
    category: z.string().optional(),
    dosage_form: z.string().optional(),
    strength: z.string().optional(),
    unit_of_measure: z.string().optional(),
    reorder_level: z.number().optional(),
    max_stock_level: z.number().optional(),
});

const stockMovementSchema = z.object({
    inventory_item_id: z.string().uuid(),
    movement_type: z.enum(['receipt', 'issue', 'adjustment', 'loss', 'return']),
    quantity: z.number().positive(),
    batch_number: z.string().optional(),
    expiry_date: z.string().optional(), // ISO date string
    notes: z.string().optional(),
    unit_cost: z.number().optional(),
    reference_number: z.string().optional(),
});

// --- Controllers ---

export const getInventoryItems = async (req: Request, res: Response) => {
    const { facilityId } = req.user!;
    const q = (req.query.q as string)?.toLowerCase();

    if (isInventoryDebug) {
        console.log(`Fetching items for facility: ${facilityId}, search: ${q || 'none'}`);
    }
    try {
        // 1. Fetch base inventory items
        let query = supabaseAdmin
            .from('inventory_items')
            .select('*')
            .eq('facility_id', facilityId)
            .eq('is_active', true);

        if (q) {
            query = query.or(`name.ilike.%${q}%,generic_name.ilike.%${q}%`);
        }

        const { data: items, error: itemsError } = await query;
        if (itemsError) throw itemsError;

        if (isInventoryDebug) {
            console.log(`Found ${items?.length || 0} inventory items`);
        }

        // Step 2: Fetch current stock from the view
        const { data: stockData, error: stockError } = await supabaseAdmin
            .from('current_stock')
            .select('inventory_item_id, current_quantity, last_movement_date')
            .eq('facility_id', facilityId);

        // Step 3: Merge data in code to avoid relation join errors
        const stockMap = new Map();
        if (stockData) {
            stockData.forEach((s: any) => {
                stockMap.set(s.inventory_item_id, s);
            });
        }

        const formatted = items.map((item) => {
            const stock = stockMap.get(item.id);
            return {
                ...item,
                current_quantity: stock?.current_quantity || 0,
                last_movement_date: stock?.last_movement_date || null
            };
        });

        return res.json(formatted);
    } catch (err: any) {
        console.error('getInventoryItems error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const createInventoryItem = async (req: Request, res: Response) => {
    const { facilityId, profileId, tenantId } = req.user!;

    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('inventory_items')
            .insert({
                ...parsed.data,
                facility_id: facilityId,
                tenant_id: tenantId,
                created_by: profileId
            })
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });

        await recordAuditEvent({
            action: 'create_inventory_item',
            eventType: 'create',
            entityType: 'inventory_item',
            tenantId,
            facilityId,
            actorUserId: profileId,
            actorRole: req.user?.role || null,
            actorIpAddress: req.ip || req.socket?.remoteAddress || null,
            actorUserAgent: req.get('user-agent') || null,
            entityId: data?.id || null,
            actionCategory: 'inventory',
            metadata: {
                itemName: data?.name || parsed.data.name,
                category: data?.category || parsed.data.category || null,
            },
            requestId: req.requestId || null,
        }, {
            strict: true,
            outboxEventType: 'audit.inventory.item.create.write_failed',
            outboxAggregateType: 'inventory_item',
            outboxAggregateId: data?.id || null,
        });

        return res.status(201).json(data);
    } catch (err: any) {
        console.error('createInventoryItem error:', err?.message || err);
        if (isAuditDurabilityError(err)) {
            return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
        }
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getInventoryStats = async (req: Request, res: Response) => {
    const { facilityId } = req.user!;
    try {
        // Direct query to current_stock view is efficient
        const { data: stockData, error } = await supabaseAdmin
            .from('current_stock')
            .select('*')
            .eq('facility_id', facilityId);

        if (error) throw error;

        const totalItems = stockData.length;
        const lowStock = stockData.filter(i => (i.current_quantity || 0) <= (i.reorder_level || 10) && (i.current_quantity || 0) > 0).length;
        const outOfStock = stockData.filter(i => (i.current_quantity || 0) <= 0).length;

        // Count items with expired stock? (Needs batch level data, current_stock view might not have it)
        // For now, simple stats.

        let stockValue = 0;
        const inventoryIds = stockData.map(item => item.inventory_item_id).filter(Boolean);
        if (inventoryIds.length > 0) {
            const { data: costRows, error: costError } = await supabaseAdmin
                .from('inventory_items')
                .select('id, unit_cost')
                .eq('facility_id', facilityId)
                .in('id', inventoryIds);

            if (costError) throw costError;

            const costById = new Map<string, number>();
            (costRows || []).forEach(row => {
                const unitCost = row.unit_cost !== null && row.unit_cost !== undefined
                    ? Number(row.unit_cost)
                    : 0;
                if (Number.isFinite(unitCost)) {
                    costById.set(row.id, unitCost);
                }
            });

            stockValue = stockData.reduce((sum, item) => {
                const quantity = Number(item.current_quantity || 0);
                const unitCost = costById.get(item.inventory_item_id) || 0;
                return sum + (quantity * unitCost);
            }, 0);
        }

        return res.json({
            facilityId,
            totalItems,
            lowStock,
            outOfStock,
            stockValue
        });
    } catch (err: any) {
        console.error('getInventoryStats error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

export const processStockMovement = async (req: Request, res: Response) => {
    const { facilityId, profileId, tenantId } = req.user!;

    const parsed = stockMovementSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }

    const { inventory_item_id, movement_type, quantity, batch_number, expiry_date, notes, unit_cost, reference_number } = parsed.data;

    // Validation: Inputs
    if (quantity <= 0) {
        return res.status(400).json({ error: "Quantity must be positive" });
    }

    try {
        // 1. Get Current Balance (locked read would be ideal, but for now standard read)
        // We get the LATEST balance_after from stock_movements
        const { data: lastMove } = await supabaseAdmin
            .from('stock_movements')
            .select('balance_after')
            .eq('inventory_item_id', inventory_item_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        const currentBalance = lastMove?.balance_after || 0;
        let newBalance = currentBalance;

        // 2. Logic based on type
        if (['receipt', 'return'].includes(movement_type)) {
            newBalance += quantity;
        } else if (['issue', 'loss', 'adjustment'].includes(movement_type)) {
            // For adjustment, if it's negative adjustment, treat as reduction. 
            // Actually, 'adjustment' usually takes a delta or a final count. 
            // Here we assume 'adjustment' means REMOVING stock (e.g. broken). 
            // If we want ADDING stock via adjustment, we need a sign or separate type 'positive_adjustment'.
            // Let's assume 'adjustment' in this context acts like 'issue' (reduction) unless specified.
            // Better: Use signed quantity? No, schema says positive.
            // Let's map strict types:
            // Receipt, Return -> ADD
            // Issue, Loss -> SUBTRACT
            // Adjustment -> Depends. Ideally we'd have 'adjustment_add' or 'adjustment_sub'. 
            // For safety, let's assume 'adjustment' here subtracts (e.g. inventory count correction down).

            if (movement_type === 'adjustment') {
                // Ambiguity risk. Let's forbid 'adjustment' via this generic handler without sign?
                // Or assume user sends negative quantity? But schema says positive.
                // Let's assume Issue/Loss reduce.
                // If type is Adjustment, allow ONLY if we know direction.
                // For now, treat Issue/Loss as subtract.
                newBalance -= quantity;
            } else {
                // Issue/Loss
                if (currentBalance < quantity) {
                    return res.status(400).json({ error: `Insufficient stock. Current: ${currentBalance}, Requested: ${quantity}` });
                }
                newBalance -= quantity;
            }
        }

        // 3. Insert Movement
        const { data, error } = await supabaseAdmin
            .from('stock_movements')
            .insert({
                inventory_item_id,
                facility_id: facilityId,
                tenant_id: tenantId,
                movement_type,
                quantity,
                balance_after: newBalance,
                batch_number,
                expiry_date,
                unit_cost,
                created_by: profileId,
                notes,
                reference_number
            })
            .select()
            .single();

        if (error) return res.status(500).json({ error: error.message });

        await recordAuditEvent({
            action: 'create_stock_movement',
            eventType: 'create',
            entityType: 'stock_movement',
            tenantId,
            facilityId,
            actorUserId: profileId,
            actorRole: req.user?.role || null,
            actorIpAddress: req.ip || req.socket?.remoteAddress || null,
            actorUserAgent: req.get('user-agent') || null,
            entityId: data?.id || null,
            actionCategory: 'inventory',
            metadata: {
                inventoryItemId: inventory_item_id,
                movementType: movement_type,
                quantity,
                balanceAfter: newBalance,
                referenceNumber: reference_number || null,
            },
            requestId: req.requestId || null,
        }, {
            strict: true,
            outboxEventType: 'audit.inventory.stock_movement.create.write_failed',
            outboxAggregateType: 'stock_movement',
            outboxAggregateId: data?.id || null,
        });

        return res.status(201).json(data);

    } catch (err: any) {
        console.error('processStockMovement error:', err?.message || err);
        if (isAuditDurabilityError(err)) {
            return sendContractError(res, 500, 'CONFLICT_AUDIT_DURABILITY_FAILURE', 'Audit durability requirement failed');
        }
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getStockMovements = async (req: Request, res: Response) => {
    const { facilityId } = req.user!;
    const itemId = req.query.itemId as string;

    try {
        let query = supabaseAdmin
            .from('stock_movements')
            .select(`
                *,
                inventory_items (name, generic_name)
            `)
            .eq('facility_id', facilityId)
            .order('created_at', { ascending: false });

        if (itemId) {
            query = query.eq('inventory_item_id', itemId);
        }

        const { data, error } = await query;
        if (error) throw error;

        return res.json(data);
    } catch (err: any) {
        console.error('getStockMovements error:', err?.message || err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
