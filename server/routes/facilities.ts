import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { normalizeWorkspaceMetadata } from '../services/workspaceMetadata';
import { respondWithDecisionReason } from '../utils/decisionReason';

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
const publicDirectoryQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  type: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const workspaceModulesUpdateSchema = z.object({
  setupMode: z.enum(['recommended', 'custom', 'full']).optional(),
  enabledModules: z.array(z.string().trim().min(1).max(64)).max(80),
});

const CORE_WORKSPACE_MODULES = [
  'patients',
  'visits',
  'records',
  'referrals',
  'follow_up',
  'link_agent',
  'cdss_core',
];

const normalizeModules = (value: string[]) => {
  const unique = new Set<string>();
  for (const entry of value) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
};

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

const loadWorkspaceMetadataByTenantId = async (tenantId?: string | null) => {
  if (!tenantId) return normalizeWorkspaceMetadata(null);

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('workspace_type, setup_mode, team_mode, enabled_modules')
    .eq('id', tenantId)
    .maybeSingle();

  if (error) {
    console.warn('Facility workspace metadata lookup failed:', error.message);
    return normalizeWorkspaceMetadata(null);
  }

  return normalizeWorkspaceMetadata(data as any);
};

const loadWorkspaceMetadataMapByTenantIds = async (tenantIds: string[]) => {
  const map = new Map<string, ReturnType<typeof normalizeWorkspaceMetadata>>();
  if (!tenantIds.length) return map;

  const uniqueTenantIds = Array.from(new Set(tenantIds.filter(Boolean)));
  if (!uniqueTenantIds.length) return map;

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('id, workspace_type, setup_mode, team_mode, enabled_modules')
    .in('id', uniqueTenantIds);

  if (error) {
    console.warn('Public facility workspace metadata lookup failed:', error.message);
    return map;
  }

  for (const row of data || []) {
    if (!row?.id) continue;
    map.set(row.id, normalizeWorkspaceMetadata(row as any));
  }

  return map;
};

const normalizeDirectorySearch = (value: string) => {
  return value.replace(/[%_]/g, '').replace(/,/g, ' ').trim();
};

/**
 * GET /api/facilities/public
 * Public directory of verified Link facilities/providers.
 */
router.get('/public', async (req, res) => {
  const parsed = publicDirectoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  try {
    const search = parsed.data.search ? normalizeDirectorySearch(parsed.data.search) : '';
    const type = (parsed.data.type || '').trim().toLowerCase();
    const limit = parsed.data.limit ?? 150;

    let query = supabaseAdmin
      .from('facilities')
      .select(
        'id, name, location, address, phone_number, facility_type, operating_hours, accepts_walk_ins, verified, tenant_id'
      )
      .eq('verified', true)
      .order('name', { ascending: true })
      .limit(limit);

    if (type && type !== 'all') {
      query = query.eq('facility_type', type);
    }

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,location.ilike.%${search}%,address.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message || 'Failed to load facilities' });
    }

    const facilities = data || [];
    const workspaceByTenant = await loadWorkspaceMetadataMapByTenantIds(
      facilities.map((facility: any) => facility.tenant_id).filter(Boolean)
    );

    return res.json({
      facilities: facilities.map((facility: any) => ({
        id: facility.id,
        name: facility.name,
        location: facility.location,
        address: facility.address,
        phone_number: facility.phone_number,
        facility_type: facility.facility_type,
        operating_hours: facility.operating_hours,
        accepts_walk_ins: facility.accepts_walk_ins,
        verified: facility.verified,
        workspace: workspaceByTenant.get(facility.tenant_id) || normalizeWorkspaceMetadata(null),
      })),
      total: facilities.length,
    });
  } catch (error: any) {
    console.error('Public facilities directory error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

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
      return respondWithDecisionReason(res, 403, { error: 'Forbidden: Facility access denied' }, 'facility_access_denied');
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

    const workspace = await loadWorkspaceMetadataByTenantId((data as any)?.tenant_id);
    return res.json({
      facility: {
        ...data,
        workspace,
      },
    });
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
      return respondWithDecisionReason(res, 403, { error: 'Forbidden: Facility access denied' }, 'facility_access_denied');
    }

    let query = supabaseAdmin
      .from('facilities')
      .select('name, location, address, tenant_id')
      .eq('id', parsed.data);

    if (req.user?.role !== 'super_admin' && req.user?.tenantId) {
      query = query.eq('tenant_id', req.user.tenantId);
    }

    const { data, error } = await query.single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const workspace = await loadWorkspaceMetadataByTenantId((data as any)?.tenant_id);
    const { tenant_id: _tenantId, ...facilityData } = data as any;
    return res.json({
      facility: {
        ...facilityData,
        workspace,
      },
    });
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
      return respondWithDecisionReason(res, 403, { error: 'Forbidden: Facility access denied' }, 'facility_access_denied');
    }

    let query = supabaseAdmin
      .from('facilities')
      .update(parsedBody.data)
      .eq('id', parsedId.data);

    if (req.user?.role !== 'super_admin' && req.user?.tenantId) {
      query = query.eq('tenant_id', req.user.tenantId);
    }

    const { data, error } = await query
      .select('id, name, location, address, phone_number, email, license_number, tenant_id')
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const workspace = await loadWorkspaceMetadataByTenantId((data as any)?.tenant_id);
    const { tenant_id: _tenantId, ...facilityData } = data as any;
    return res.json({
      facility: {
        ...facilityData,
        workspace,
      },
    });
  } catch (err: any) {
    console.error('Facility update error:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/facilities/:id/workspace/modules
 * Updates workspace module visibility/staging preferences for clinic admin.
 */
router.patch('/:id/workspace/modules', requireUser, requireScopedUser, async (req, res) => {
  const parsedId = facilityIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ error: 'Invalid facility id' });
  }

  const parsedBody = workspaceModulesUpdateSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: parsedBody.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const hasAccess = await resolveFacilityAccess(req, parsedId.data);
    if (!hasAccess) {
      return respondWithDecisionReason(res, 403, { error: 'Forbidden: Facility access denied' }, 'facility_access_denied');
    }

    let facilityQuery = supabaseAdmin
      .from('facilities')
      .select('id, tenant_id')
      .eq('id', parsedId.data);

    if (req.user?.role !== 'super_admin' && req.user?.tenantId) {
      facilityQuery = facilityQuery.eq('tenant_id', req.user.tenantId);
    }

    const { data: facility, error: facilityError } = await facilityQuery.maybeSingle();
    if (facilityError) {
      return res.status(500).json({ error: facilityError.message });
    }
    if (!facility || !facility.tenant_id) {
      return res.status(404).json({ error: 'Facility workspace not found' });
    }

    const { data: tenantRow, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .select('workspace_type, setup_mode, team_mode, enabled_modules')
      .eq('id', facility.tenant_id)
      .maybeSingle();

    if (tenantError) {
      return res.status(500).json({ error: tenantError.message });
    }
    if (!tenantRow) {
      return res.status(404).json({ error: 'Workspace metadata not found' });
    }

    const currentWorkspace = normalizeWorkspaceMetadata(tenantRow as any);
    const setupMode = parsedBody.data.setupMode || (currentWorkspace.setupMode === 'legacy' ? 'custom' : currentWorkspace.setupMode);
    const enabledModules = normalizeModules([...CORE_WORKSPACE_MODULES, ...parsedBody.data.enabledModules]);

    const { data: updatedTenant, error: updateError } = await supabaseAdmin
      .from('tenants')
      .update({
        setup_mode: setupMode,
        enabled_modules: enabledModules,
      })
      .eq('id', facility.tenant_id)
      .select('workspace_type, setup_mode, team_mode, enabled_modules')
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    return res.json({
      workspace: normalizeWorkspaceMetadata(updatedTenant as any),
    });
  } catch (err: any) {
    console.error('Facility workspace modules update error:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
