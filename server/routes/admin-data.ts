import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';

const router = Router();
router.use(requireUser, requireScopedUser);

const adminRoles = new Set([
  'admin',
  'clinic_admin',
  'super_admin',
  'hospital_ceo',
  'medical_director',
  'nursing_head',
]);

const ensureAdmin = (req: any, res: any) => {
  const role = req.user?.role;
  if (!role || !adminRoles.has(role)) {
    res.status(403).json({ error: 'You do not have permission to manage master data.' });
    return false;
  }
  return true;
};

const resolveFacilityContext = async (req: any) => {
  const { authUserId, facilityId: defaultFacilityId, tenantId } = req.user!;
  const requestedFacilityId = (req.query.facilityId as string | undefined) || defaultFacilityId;

  if (!requestedFacilityId) {
    return { facilityId: undefined, tenantId };
  }

  if (req.user?.role === 'super_admin') {
    return { facilityId: requestedFacilityId, tenantId };
  }

  const { data } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .eq('facility_id', requestedFacilityId)
    .maybeSingle();

  if (!data) {
    return { facilityId: undefined, tenantId };
  }

  return { facilityId: requestedFacilityId, tenantId };
};

const canAccessScopedRecord = (
  record: { tenant_id?: string | null; facility_id?: string | null },
  scope: { tenantId: string; facilityId: string },
  mode: 'tenant_or_facility' | 'facility_only'
) => {
  if (record.tenant_id !== scope.tenantId) return false;
  if (mode === 'facility_only') {
    return record.facility_id === scope.facilityId;
  }
  return record.facility_id === null || record.facility_id === scope.facilityId;
};

const stripMetaFields = (payload: Record<string, any>) => {
  const {
    id,
    created_at,
    updated_at,
    created_by,
    facility_id,
    tenant_id,
    ...cleaned
  } = payload;
  return cleaned;
};

const genericTables: Record<
  string,
  {
    table: string;
    scope: 'tenant_or_facility' | 'facility_only';
    orderBy?: Array<{ column: string; ascending?: boolean }>;
  }
> = {
  insurers: {
    table: 'insurers',
    scope: 'tenant_or_facility',
    orderBy: [{ column: 'name', ascending: true }],
  },
  suppliers: {
    table: 'suppliers',
    scope: 'tenant_or_facility',
    orderBy: [{ column: 'name', ascending: true }],
  },
  service_categories: {
    table: 'service_categories',
    scope: 'tenant_or_facility',
    orderBy: [
      { column: 'display_order', ascending: true },
      { column: 'name', ascending: true },
    ],
  },
  creditors: {
    table: 'creditors',
    scope: 'tenant_or_facility',
    orderBy: [{ column: 'name', ascending: true }],
  },
  programs: {
    table: 'programs',
    scope: 'tenant_or_facility',
    orderBy: [{ column: 'name', ascending: true }],
  },
  medical_services: {
    table: 'medical_services',
    scope: 'tenant_or_facility',
    orderBy: [{ column: 'name', ascending: true }],
  },
};

const bulkSchema = z.object({
  rows: z.array(z.record(z.any())).min(1),
});

const analyticsSchema = z.object({
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  facilityId: z.string().uuid().optional(),
});

router.get('/:table', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const tableKey = req.params.table;
  const config = genericTables[tableKey];
  if (!config) {
    return res.status(404).json({ error: 'Unsupported table' });
  }

  const { facilityId, tenantId } = await resolveFacilityContext(req);
  if (!facilityId || !tenantId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  try {
    let query = supabaseAdmin.from(config.table).select('*').eq('tenant_id', tenantId);
    if (config.scope === 'tenant_or_facility') {
      query = query.or(`facility_id.is.null,facility_id.eq.${facilityId}`);
    } else {
      query = query.eq('facility_id', facilityId);
    }

    (config.orderBy || []).forEach((order) => {
      query = query.order(order.column, { ascending: order.ascending ?? true });
    });

    const { data, error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ items: data || [] });
  } catch (error: any) {
    console.error('Admin data list error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:table', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const tableKey = req.params.table;
  const config = genericTables[tableKey];
  if (!config) {
    return res.status(404).json({ error: 'Unsupported table' });
  }

  const { facilityId, tenantId } = await resolveFacilityContext(req);
  if (!facilityId || !tenantId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  try {
    const payload = stripMetaFields(req.body || {});
    const insertPayload = {
      ...payload,
      facility_id: facilityId,
      tenant_id: tenantId,
      created_by: req.user?.profileId,
    };

    const { data, error } = await supabaseAdmin
      .from(config.table)
      .insert(insertPayload)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ item: data });
  } catch (error: any) {
    console.error('Admin data create error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:table/:id', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const tableKey = req.params.table;
  const config = genericTables[tableKey];
  if (!config) {
    return res.status(404).json({ error: 'Unsupported table' });
  }

  try {
    const { facilityId, tenantId } = await resolveFacilityContext(req);
    if (!facilityId || !tenantId) {
      return res.status(400).json({ error: 'Missing facility context' });
    }

    const { data: target, error: targetError } = await supabaseAdmin
      .from(config.table)
      .select('id, tenant_id, facility_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (targetError) {
      return res.status(500).json({ error: targetError.message });
    }
    if (!target) {
      return res.status(404).json({ error: 'Record not found' });
    }
    if (!canAccessScopedRecord(target, { facilityId, tenantId }, config.scope)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const payload = stripMetaFields(req.body || {});
    let query = supabaseAdmin
      .from(config.table)
      .update(payload)
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId);

    if (target.facility_id === null && config.scope === 'tenant_or_facility') {
      query = query.is('facility_id', null);
    } else {
      query = query.eq('facility_id', facilityId);
    }

    const { data, error } = await query
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ item: data });
  } catch (error: any) {
    console.error('Admin data update error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:table/:id', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const tableKey = req.params.table;
  const config = genericTables[tableKey];
  if (!config) {
    return res.status(404).json({ error: 'Unsupported table' });
  }

  try {
    const { facilityId, tenantId } = await resolveFacilityContext(req);
    if (!facilityId || !tenantId) {
      return res.status(400).json({ error: 'Missing facility context' });
    }

    const { data: target, error: targetError } = await supabaseAdmin
      .from(config.table)
      .select('id, tenant_id, facility_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (targetError) {
      return res.status(500).json({ error: targetError.message });
    }
    if (!target) {
      return res.status(404).json({ error: 'Record not found' });
    }
    if (!canAccessScopedRecord(target, { facilityId, tenantId }, config.scope)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let query = supabaseAdmin
      .from(config.table)
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId);

    if (target.facility_id === null && config.scope === 'tenant_or_facility') {
      query = query.is('facility_id', null);
    } else {
      query = query.eq('facility_id', facilityId);
    }

    const { error } = await query;
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Admin data delete error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:table/bulk', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const tableKey = req.params.table;
  const config = genericTables[tableKey];
  if (!config) {
    return res.status(404).json({ error: 'Unsupported table' });
  }

  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { facilityId, tenantId } = await resolveFacilityContext(req);
  if (!facilityId || !tenantId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  try {
    const rows = parsed.data.rows.map((row) => ({
      ...stripMetaFields(row),
      facility_id: facilityId,
      tenant_id: tenantId,
      created_by: req.user?.profileId,
    }));

    const { data, error } = await supabaseAdmin.from(config.table).insert(rows).select();
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ inserted: data?.length || 0 });
  } catch (error: any) {
    console.error('Admin data bulk error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const departmentSchema = z.object({
  name: z.string().min(1),
  code: z.string().nullable().optional(),
  department_type: z.string().min(1),
  total_beds: z.number().nullable().optional(),
  location_building: z.string().nullable().optional(),
  location_floor: z.string().nullable().optional(),
  is_active: z.boolean().default(true),
  operating_days: z.array(z.string()).nullable().optional(),
  opens_at: z.string().nullable().optional(),
  closes_at: z.string().nullable().optional(),
  is_24h: z.boolean().default(false),
});

router.get('/departments', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { facilityId } = await resolveFacilityContext(req);
  if (!facilityId) return res.status(400).json({ error: 'Missing facility context' });

  const activeOnly = req.query.activeOnly === 'true';
  try {
    let query = supabaseAdmin.from('departments').select('*').eq('facility_id', facilityId);
    if (activeOnly) {
      query = query.eq('is_active', true);
    }
    const { data, error } = await query.order('name');
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ items: data || [] });
  } catch (error: any) {
    console.error('Departments list error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/departments', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const parsed = departmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }
  const { facilityId, tenantId } = await resolveFacilityContext(req);
  if (!facilityId || !tenantId) return res.status(400).json({ error: 'Missing facility context' });

  try {
    const payload = parsed.data;
    const totalBeds = payload.total_beds ?? 0;
    const { data, error } = await supabaseAdmin
      .from('departments')
      .insert({
        ...payload,
        facility_id: facilityId,
        tenant_id: tenantId,
        available_beds: totalBeds,
        occupied_beds: 0,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ item: data });
  } catch (error: any) {
    console.error('Department create error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/departments/bulk', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }
  const { facilityId, tenantId } = await resolveFacilityContext(req);
  if (!facilityId || !tenantId) return res.status(400).json({ error: 'Missing facility context' });

  try {
    const rows = parsed.data.rows.map((row) => {
      const payload = departmentSchema.partial().parse(row);
      const totalBeds = payload.total_beds ?? 0;
      return {
        ...payload,
        facility_id: facilityId,
        tenant_id: tenantId,
        available_beds: totalBeds,
        occupied_beds: 0,
        is_active: payload.is_active ?? true,
      };
    });

    const { data, error } = await supabaseAdmin.from('departments').insert(rows).select();
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.json({ inserted: data?.length || 0 });
  } catch (error: any) {
    console.error('Department bulk error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/departments/:id', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const parsed = departmentSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { facilityId, tenantId } = await resolveFacilityContext(req);
    if (!facilityId || !tenantId) return res.status(400).json({ error: 'Missing facility context' });

    const { data: target, error: targetError } = await supabaseAdmin
      .from('departments')
      .select('id')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId)
      .maybeSingle();

    if (targetError) return res.status(500).json({ error: targetError.message });
    if (!target) return res.status(404).json({ error: 'Department not found' });

    const payload = parsed.data;
    const { data, error } = await supabaseAdmin
      .from('departments')
      .update(payload)
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ item: data });
  } catch (error: any) {
    console.error('Department update error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/departments/:id', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const { facilityId, tenantId } = await resolveFacilityContext(req);
    if (!facilityId || !tenantId) return res.status(400).json({ error: 'Missing facility context' });

    const { data: target, error: targetError } = await supabaseAdmin
      .from('departments')
      .select('id')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId)
      .maybeSingle();

    if (targetError) return res.status(500).json({ error: targetError.message });
    if (!target) return res.status(404).json({ error: 'Department not found' });

    const { error } = await supabaseAdmin
      .from('departments')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Department delete error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const wardSchema = z.object({
  name: z.string().min(1),
  code: z.string().nullable().optional(),
  ward_type: z.string().min(1),
  department_id: z.string().uuid(),
  total_beds: z.number().nullable().optional(),
  gender_restriction: z.string().nullable().optional(),
  location_floor: z.string().nullable().optional(),
  location_wing: z.string().nullable().optional(),
  is_active: z.boolean().default(true),
});

router.get('/wards', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { facilityId } = await resolveFacilityContext(req);
  if (!facilityId) return res.status(400).json({ error: 'Missing facility context' });

  try {
    const { data, error } = await supabaseAdmin
      .from('wards')
      .select('*, department:departments(name)')
      .eq('facility_id', facilityId)
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ items: data || [] });
  } catch (error: any) {
    console.error('Wards list error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wards', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const parsed = wardSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }
  const { facilityId, tenantId } = await resolveFacilityContext(req);
  if (!facilityId || !tenantId) return res.status(400).json({ error: 'Missing facility context' });

  try {
    const payload = parsed.data;
    const totalBeds = payload.total_beds ?? 0;
    const { data, error } = await supabaseAdmin
      .from('wards')
      .insert({
        ...payload,
        facility_id: facilityId,
        tenant_id: tenantId,
        available_beds: totalBeds,
        occupied_beds: 0,
        cleaning_beds: 0,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ item: data });
  } catch (error: any) {
    console.error('Ward create error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/wards/:id', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const parsed = wardSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { facilityId, tenantId } = await resolveFacilityContext(req);
    if (!facilityId || !tenantId) return res.status(400).json({ error: 'Missing facility context' });

    const { data: target, error: targetError } = await supabaseAdmin
      .from('wards')
      .select('id')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId)
      .maybeSingle();

    if (targetError) return res.status(500).json({ error: targetError.message });
    if (!target) return res.status(404).json({ error: 'Ward not found' });

    const { data, error } = await supabaseAdmin
      .from('wards')
      .update(parsed.data)
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ item: data });
  } catch (error: any) {
    console.error('Ward update error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/wards/:id', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const { facilityId, tenantId } = await resolveFacilityContext(req);
    if (!facilityId || !tenantId) return res.status(400).json({ error: 'Missing facility context' });

    const { data: target, error: targetError } = await supabaseAdmin
      .from('wards')
      .select('id')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId)
      .maybeSingle();

    if (targetError) return res.status(500).json({ error: targetError.message });
    if (!target) return res.status(404).json({ error: 'Ward not found' });

    const { error } = await supabaseAdmin
      .from('wards')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('facility_id', facilityId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Ward delete error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wards/bulk', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }
  const { facilityId, tenantId } = await resolveFacilityContext(req);
  if (!facilityId || !tenantId) return res.status(400).json({ error: 'Missing facility context' });

  try {
    const rows = parsed.data.rows.map((row) => {
      const payload = wardSchema.partial().parse(row);
      const totalBeds = payload.total_beds ?? 0;
      return {
        ...payload,
        facility_id: facilityId,
        tenant_id: tenantId,
        available_beds: totalBeds,
        occupied_beds: 0,
        cleaning_beds: 0,
        is_active: payload.is_active ?? true,
      };
    });

    const { data, error } = await supabaseAdmin.from('wards').insert(rows).select();
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.json({ inserted: data?.length || 0 });
  } catch (error: any) {
    console.error('Ward bulk error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin-data/analytics/patient-flow
 * Returns visit + staff data for patient flow analytics.
 */
router.get('/analytics/patient-flow', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { facilityId: resolvedFacilityId, tenantId } = await resolveFacilityContext(req);

  const parsed = analyticsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const { startDate, endDate, facilityId: queryFacilityId } = parsed.data;
  const facilityId = queryFacilityId || resolvedFacilityId;

  if (!facilityId && req.user?.role !== 'super_admin') {
    return res.status(400).json({ error: 'Missing facility context' });
  }
  if (!facilityId && !tenantId) {
    return res.status(400).json({ error: 'Missing tenant context' });
  }

  try {
    let staffQuery = supabaseAdmin
      .from('users')
      .select('id, name, user_role')
      .neq('user_role', 'receptionist');

    if (facilityId) {
      staffQuery = staffQuery.eq('facility_id', facilityId);
    } else if (tenantId) {
      staffQuery = staffQuery.eq('tenant_id', tenantId);
    }

    let visitQuery = supabaseAdmin
      .from('visits')
      .select('id, created_by, visit_date')
      .gte('visit_date', startDate)
      .lte('visit_date', endDate);

    if (facilityId) {
      visitQuery = visitQuery.eq('facility_id', facilityId);
    } else if (tenantId) {
      visitQuery = visitQuery.eq('tenant_id', tenantId);
    }

    const [{ data: visitsData, error: visitsScopedError }, { data: staff, error: staffError }] =
      await Promise.all([visitQuery, staffQuery]);

    if (visitsScopedError) throw visitsScopedError;
    if (staffError) throw staffError;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_patient_flow',
        eventType: 'read',
        entityType: 'visit_list',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: req.user?.profileId || null,
        actorRole: req.user?.role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { visit_count: (visitsData || []).length, staff_count: (staff || []).length },
      });
    }

    return res.json({ visits: visitsData || [], staff: staff || [] });
  } catch (error: any) {
    console.error('Patient flow analytics error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load patient flow data' });
  }
});

/**
 * GET /api/admin-data/analytics/clinical
 * Returns visit data for clinical analytics dashboards.
 */
router.get('/analytics/clinical', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { facilityId: resolvedFacilityId, tenantId } = await resolveFacilityContext(req);

  const parsed = analyticsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const { startDate, endDate, facilityId: queryFacilityId } = parsed.data;
  const facilityId = queryFacilityId || resolvedFacilityId;

  if (!facilityId && req.user?.role !== 'super_admin') {
    return res.status(400).json({ error: 'Missing facility context' });
  }
  if (!facilityId && !tenantId) {
    return res.status(400).json({ error: 'Missing tenant context' });
  }

  try {
    let visitQuery = supabaseAdmin
      .from('visits')
      .select(
        `
          id,
          visit_date,
          provider,
          fee_paid,
          reason,
          clinical_notes,
          billing_items (
            quantity,
            unit_price,
            total_amount,
            medical_services (name, category)
          )
        `
      )
      .gte('visit_date', startDate)
      .lte('visit_date', endDate);

    if (facilityId) {
      visitQuery = visitQuery.eq('facility_id', facilityId);
    } else if (tenantId) {
      visitQuery = visitQuery.eq('tenant_id', tenantId);
    }

    const { data: visits, error } = await visitQuery;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_clinical_analytics',
        eventType: 'read',
        entityType: 'visit_list',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: req.user?.profileId || null,
        actorRole: req.user?.role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { visit_count: (visits || []).length },
      });
    }

    return res.json({ visits: visits || [] });
  } catch (error: any) {
    console.error('Clinical analytics error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load clinical analytics' });
  }
});

/**
 * GET /api/admin-data/analytics/followups
 * Returns visit + patient data for follow-up tracking.
 */
router.get('/analytics/followups', async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const { facilityId: resolvedFacilityId, tenantId } = await resolveFacilityContext(req);

  const parsed = analyticsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const { startDate, endDate, facilityId: queryFacilityId } = parsed.data;
  const facilityId = queryFacilityId || resolvedFacilityId;

  if (!facilityId && req.user?.role !== 'super_admin') {
    return res.status(400).json({ error: 'Missing facility context' });
  }
  if (!facilityId && !tenantId) {
    return res.status(400).json({ error: 'Missing tenant context' });
  }

  try {
    let visitQuery = supabaseAdmin
      .from('visits')
      .select(
        `
          id,
          patient_id,
          visit_date,
          reason,
          clinical_notes,
          patients (id, full_name, phone)
        `
      )
      .gte('visit_date', startDate)
      .lte('visit_date', endDate);

    if (facilityId) {
      visitQuery = visitQuery.eq('facility_id', facilityId);
    } else if (tenantId) {
      visitQuery = visitQuery.eq('tenant_id', tenantId);
    }

    const { data: visits, error } = await visitQuery;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_followup_tracking',
        eventType: 'read',
        entityType: 'visit_list',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: req.user?.profileId || null,
        actorRole: req.user?.role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { visit_count: (visits || []).length },
      });
    }

    return res.json({ visits: visits || [] });
  } catch (error: any) {
    console.error('Followup tracking error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load follow-up data' });
  }
});

export default router;
