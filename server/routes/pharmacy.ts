import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';

const router = Router();
router.use(requireUser, requireScopedUser);

const stockRequestSchema = z.object({
  medication_name: z.string().min(1),
  generic_name: z.string().optional().nullable(),
  requested_quantity: z.number().optional().nullable(),
  current_stock: z.number().optional().nullable(),
  urgency: z.enum(['normal', 'high', 'urgent']).optional().nullable(),
  message: z.string().optional().nullable(),
});

router.post('/stock-requests', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  if (!facilityId || !tenantId || !profileId) {
    return res.status(400).json({ error: 'Missing facility or user context' });
  }

  const parsed = stockRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { medication_name, generic_name, requested_quantity, current_stock, urgency, message } = parsed.data;

    const { error } = await supabaseAdmin
      .from('stock_requests')
      .insert({
        medication_name,
        generic_name: generic_name || null,
        requested_quantity: requested_quantity ?? null,
        current_stock: current_stock ?? null,
        urgency: urgency || 'normal',
        requested_by: profileId,
        facility_id: facilityId,
        tenant_id: tenantId,
        message: message || null,
        status: 'pending',
      });

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'create_stock_request',
        eventType: 'create',
        entityType: 'stock_request',
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { medication_name },
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to create stock request' });
  }
});

export default router;
