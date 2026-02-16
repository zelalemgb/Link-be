import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';

const router = Router();

const facilityIdSchema = z.string().uuid();
const facilityUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  location: z.string().min(2).optional(),
  address: z.string().min(5).optional(),
  phone_number: z.string().min(8).max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  license_number: z.string().min(2).nullable().optional(),
});

const resolveFacilityAccess = async (req: any, facilityId: string) => {
  const { role, authUserId, facilityId: defaultFacilityId, tenantId } = req.user || {};
  if (!facilityId) return false;
  if (role === 'super_admin') return true;

  if (defaultFacilityId && defaultFacilityId === facilityId) {
    return true;
  }

  if (!authUserId) return false;

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, tenant_id')
    .eq('auth_user_id', authUserId)
    .eq('facility_id', facilityId)
    .maybeSingle();

  if (error || !data) return false;
  if (tenantId && data.tenant_id && data.tenant_id !== tenantId) return false;

  return true;
};

/**
 * GET /api/facilities/:id
 * Returns full facility info for admin workflows.
 */
router.get('/:id', requireUser, requireScopedUser, async (req, res) => {
  const parsed = facilityIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid facility id' });
  }

  try {
    const hasAccess = await resolveFacilityAccess(req, parsed.data);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Forbidden: Facility access denied' });
    }

    let query = supabaseAdmin
      .from('facilities')
      .select('id, name, location, address, phone_number, email, clinic_code, tenant_id, verification_status')
      .eq('id', parsed.data);

    if (req.user?.role !== 'super_admin' && req.user?.tenantId) {
      query = query.eq('tenant_id', req.user.tenantId);
    }

    const { data, error } = await query.single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ facility: data });
  } catch (err: any) {
    console.error('Facility info error:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/facilities/:id/basic
 * Returns basic facility info for dashboard headers.
 */
router.get('/:id/basic', requireUser, requireScopedUser, async (req, res) => {
  const parsed = facilityIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid facility id' });
  }

  try {
    const hasAccess = await resolveFacilityAccess(req, parsed.data);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Forbidden: Facility access denied' });
    }

    let query = supabaseAdmin
      .from('facilities')
      .select('name, location, address')
      .eq('id', parsed.data);

    if (req.user?.role !== 'super_admin' && req.user?.tenantId) {
      query = query.eq('tenant_id', req.user.tenantId);
    }

    const { data, error } = await query.single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ facility: data });
  } catch (err: any) {
    console.error('Facility basic info error:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/facilities/:id
 * Updates facility settings for admin workflows.
 */
router.put('/:id', requireUser, requireScopedUser, async (req, res) => {
  const parsedId = facilityIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ error: 'Invalid facility id' });
  }

  const parsedBody = facilityUpdateSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const hasAccess = await resolveFacilityAccess(req, parsedId.data);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Forbidden: Facility access denied' });
    }

    let query = supabaseAdmin
      .from('facilities')
      .update(parsedBody.data)
      .eq('id', parsedId.data);

    if (req.user?.role !== 'super_admin' && req.user?.tenantId) {
      query = query.eq('tenant_id', req.user.tenantId);
    }

    const { data, error } = await query
      .select('id, name, location, address, phone_number, email, license_number')
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ facility: data });
  } catch (err: any) {
    console.error('Facility update error:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
