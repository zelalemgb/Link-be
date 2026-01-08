import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { requireUser } from '../middleware/auth';

const router = Router();
router.use(requireUser);

/**
 * GET /api/staff/clinicians
 * Returns doctors and clinical officers for the user's facility
 */
router.get('/clinicians', async (req, res) => {
    const { facilityId } = req.user!;
    try {
        if (!facilityId) {
            return res.status(400).json({ error: 'User does not belong to a facility' });
        }

        const { data, error } = await supabaseAdmin
            .from('users')
            .select('id, name, user_role')
            .eq('facility_id', facilityId)
            .in('user_role', ['doctor', 'clinical_officer'])
            .order('name');

        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
