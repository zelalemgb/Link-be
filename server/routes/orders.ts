import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';

const router = Router();
router.use(requireUser);

const countsQuerySchema = z.object({
  visitIds: z.string().optional(),
});

router.get('/counts', async (req, res) => {
  const parsed = countsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const visitIds = parsed.data.visitIds
    ? parsed.data.visitIds.split(',').map((id) => id.trim()).filter(Boolean)
    : [];

  if (visitIds.length === 0) {
    return res.json({ counts: {} });
  }

  try {
    const [labResult, imagingResult, medicationResult] = await Promise.all([
      supabaseAdmin
        .from('lab_orders')
        .select('visit_id, status, result')
        .in('visit_id', visitIds),
      supabaseAdmin
        .from('imaging_orders')
        .select('visit_id, status, result')
        .in('visit_id', visitIds),
      supabaseAdmin
        .from('medication_orders')
        .select('visit_id, status')
        .in('visit_id', visitIds),
    ]);

    if (labResult.error) throw labResult.error;
    if (imagingResult.error) throw imagingResult.error;
    if (medicationResult.error) throw medicationResult.error;

    const counts: Record<string, {
      lab_pending: number;
      lab_ready: number;
      imaging_pending: number;
      imaging_ready: number;
      medication_pending: number;
      medication_dispensed: number;
    }> = {};

    visitIds.forEach((visitId) => {
      const visitLabs = (labResult.data || []).filter((o) => o.visit_id === visitId);
      const visitImaging = (imagingResult.data || []).filter((o) => o.visit_id === visitId);
      const visitMeds = (medicationResult.data || []).filter((o) => o.visit_id === visitId);

      counts[visitId] = {
        lab_pending: visitLabs.filter((o) => o.status !== 'completed' || !o.result).length,
        lab_ready: visitLabs.filter((o) => o.status === 'completed' && o.result).length,
        imaging_pending: visitImaging.filter((o) => o.status !== 'completed' || !o.result).length,
        imaging_ready: visitImaging.filter((o) => o.status === 'completed' && o.result).length,
        medication_pending: visitMeds.filter((o) => o.status !== 'dispensed').length,
        medication_dispensed: visitMeds.filter((o) => o.status === 'dispensed').length,
      };
    });

    return res.json({ counts });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unable to fetch order counts' });
  }
});

export default router;

