/* eslint-disable @typescript-eslint/no-explicit-any */
import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { buildScopedCatalogKey, preferFacilityScopedRows } from '../services/masterDataCatalog';

const router = Router();
router.use(requireUser, requireScopedUser);

const masterDataAdminRoles = new Set([
  'admin',
  'clinic_admin',
  'super_admin',
  'hospital_ceo',
  'medical_director',
  'nursing_head',
]);

const requestedFacilityIdSchema = z.string().uuid();
const masterCatalogScopeSchema = z.enum(['tenant', 'facility']);

const serviceSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  price: z.number().nullable().optional(),
  category: z.string().optional(),
  is_active: z.boolean().default(true),
  scope: masterCatalogScopeSchema.default('tenant'),
});

const programSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional().nullable(),
  is_active: z.boolean().default(true),
  scope: masterCatalogScopeSchema.default('tenant'),
});

const medicationSchema = z.object({
  medication_name: z.string().min(1),
  generic_name: z.string().optional().nullable(),
  dosage_form: z.string(),
  strength: z.string().optional().nullable(),
  route: z.string(),
  category: z.string(),
  icd11_code: z.string().optional().nullable(),
  is_active: z.boolean().default(true),
  scope: masterCatalogScopeSchema.default('tenant'),
});

const labCatalogSchema = z.object({
  test_code: z.string().min(1),
  test_name: z.string().min(1),
  category: z.string().min(1),
  panel_name: z.string().optional().nullable(),
  reference_range_general: z.string().optional().nullable(),
  reference_range_male: z.string().optional().nullable(),
  reference_range_female: z.string().optional().nullable(),
  unit_of_measure: z.string().min(1),
  sample_type: z.string().min(1),
  critical_low: z.string().optional().nullable(),
  critical_high: z.string().optional().nullable(),
  method: z.string().optional().nullable(),
  turnaround_time_hours: z.number().int().nullable().optional(),
  is_active: z.boolean().default(true),
  scope: masterCatalogScopeSchema.default('tenant'),
});

const imagingSchema = z.object({
  study_name: z.string().min(1),
  study_code: z.string().optional().nullable(),
  modality: z.string(),
  body_part: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  preparation_instructions: z.string().optional().nullable(),
  estimated_duration_minutes: z.number().nullable().optional(),
  price: z.number().nullable().optional(),
  is_active: z.boolean().default(true),
  scope: masterCatalogScopeSchema.default('tenant'),
});

const equipmentSchema = z.object({
  equipment_name: z.string().min(1),
  equipment_code: z.string().optional().nullable(),
  category: z.string().min(1),
  unit_of_measure: z.string().min(1),
  manufacturer: z.string().optional().nullable(),
  model_number: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  is_active: z.boolean().default(true),
  scope: masterCatalogScopeSchema.default('tenant'),
});

const ensureMasterDataAdmin = (req: any, res: any) => {
  const role = req.user?.role;
  if (!role || !masterDataAdminRoles.has(role)) {
    res.status(403).json({ error: 'You do not have permission to manage master data.' });
    return false;
  }
  return true;
};

const readRequestedFacilityId = (req: any) => {
  if (typeof req.body?.facilityId === 'string') return req.body.facilityId;
  if (typeof req.query?.facilityId === 'string') return req.query.facilityId;
  const headerValue = req.header?.('x-link-facility-id');
  return typeof headerValue === 'string' ? headerValue : null;
};

const facilityScopeFilter = (facilityId: string | null) =>
  facilityId ? `facility_id.is.null,facility_id.eq.${facilityId}` : 'facility_id.is.null';

const applyScopedFacilityFilter = (query: any, facilityId: string | null) => {
  return facilityId ? query.or(facilityScopeFilter(facilityId)) : query.is('facility_id', null);
};

const readIncludeInactive = (req: any) => req.query?.includeInactive === 'true';

const resolveScopedFacilityId = (
  scope: z.infer<typeof masterCatalogScopeSchema> | undefined,
  facilityId: string | null,
  fallback: z.infer<typeof masterCatalogScopeSchema> = 'facility'
) => {
  const targetScope = scope ?? fallback;
  if (targetScope === 'tenant') return null;
  if (!facilityId) {
    throw new Error('Missing facility context');
  }
  return facilityId;
};

const requireMasterDataScope = async (req: any, res: any) => {
  const { authUserId, profileId, tenantId, facilityId, role } = req.user || {};

  const requestedFacilityId = readRequestedFacilityId(req);
  if (!requestedFacilityId) {
    if (!tenantId) {
      res.status(403).json({ error: 'Missing tenant context' });
      return null;
    }

    return {
      tenantId,
      facilityId: facilityId || null,
      profileId: profileId || null,
    };
  }

  const parsedFacilityId = requestedFacilityIdSchema.safeParse(requestedFacilityId);
  if (!parsedFacilityId.success) {
    res.status(400).json({ error: 'Invalid facility id' });
    return null;
  }

  if (parsedFacilityId.data === facilityId) {
    if (!tenantId) {
      res.status(403).json({ error: 'Missing tenant context' });
      return null;
    }

    return {
      tenantId,
      facilityId: facilityId || null,
      profileId: profileId || null,
    };
  }

  if (role === 'super_admin') {
    const { data: facilityRow, error: facilityError } = await supabaseAdmin
      .from('facilities')
      .select('id, tenant_id')
      .eq('id', parsedFacilityId.data)
      .maybeSingle();

    if (facilityError) {
      res.status(500).json({ error: facilityError.message });
      return null;
    }

    if (!facilityRow?.tenant_id) {
      res.status(404).json({ error: 'Facility not found' });
      return null;
    }

    return {
      tenantId: facilityRow.tenant_id,
      facilityId: facilityRow.id,
      profileId: profileId || null,
    };
  }

  if (!tenantId || !authUserId) {
    res.status(403).json({ error: 'Missing tenant context' });
    return null;
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('users')
    .select('id, facility_id, tenant_id')
    .eq('auth_user_id', authUserId)
    .eq('tenant_id', tenantId)
    .eq('facility_id', parsedFacilityId.data)
    .limit(1)
    .maybeSingle();

  if (membershipError) {
    res.status(500).json({ error: membershipError.message });
    return null;
  }

  if (!membership?.facility_id) {
    res.status(403).json({ error: 'Facility access denied' });
    return null;
  }

  return {
    tenantId,
    facilityId: membership.facility_id,
    profileId: membership.id || profileId || null,
  };
};

const medicationIdentity = (row: any) =>
  buildScopedCatalogKey([
    row.medication_name,
    row.generic_name,
    row.dosage_form,
    row.strength,
    row.route,
  ]);

const labCatalogIdentity = (row: any) =>
  buildScopedCatalogKey([row.test_code || row.test_name]);

const serviceIdentity = (row: any) =>
  buildScopedCatalogKey([row.code || row.name, row.category]);

const programIdentity = (row: any) =>
  buildScopedCatalogKey([row.code || row.name]);

const imagingIdentity = (row: any) =>
  buildScopedCatalogKey([row.study_code || row.study_name, row.modality, row.body_part]);

const equipmentIdentity = (row: any) =>
  buildScopedCatalogKey([row.equipment_code || row.equipment_name, row.category]);

router.get('/services', async (req, res) => {
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;
  const { category } = req.query;

  try {
    let query = supabaseAdmin
      .from('medical_services')
      .select('*')
      .eq('tenant_id', tenantId);

    if (typeof category === 'string' && category.length > 0) {
      query = query.eq('category', category);
    }

    query = applyScopedFacilityFilter(query, facilityId);

    const { data, error } = await query.order('category').order('name');

    if (error) throw error;
    const resolved = preferFacilityScopedRows(data || [], serviceIdentity).sort((left, right) => {
      const categoryCompare = String(left.category || '').localeCompare(String(right.category || ''));
      if (categoryCompare !== 0) return categoryCompare;
      return String(left.name || '').localeCompare(String(right.name || ''));
    });
    res.json(resolved);
  } catch (error: any) {
    console.error('Fetch services error:', error?.message || error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/services', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId, profileId } = scope;

  try {
    const payload = serviceSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;
    const { data, error } = await supabaseAdmin
      .from('medical_services')
      .insert({
        ...dataFields,
        tenant_id: tenantId,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
        created_by: profileId,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/services/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const payload = serviceSchema.partial().parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;
    let query = supabaseAdmin
      .from('medical_services')
      .update({
        ...dataFields,
        facility_id:
          recordScope === undefined
            ? undefined
            : resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
      })
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id)
      .select();

    query = query.or(facilityScopeFilter(facilityId));

    const { data, error } = await query.single();
    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/services/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    let query = supabaseAdmin
      .from('medical_services')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id);

    query = query.or(facilityScopeFilter(facilityId));

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/programs', async (req, res) => {
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const { data, error } = await applyScopedFacilityFilter(
      supabaseAdmin
        .from('programs')
        .select('*')
        .eq('tenant_id', tenantId),
      facilityId
    ).order('name');

    if (error) throw error;
    const resolved = preferFacilityScopedRows(data || [], programIdentity).sort((left, right) =>
      String(left.name || '').localeCompare(String(right.name || ''))
    );
    res.json(resolved);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/programs', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const payload = programSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;
    const { data, error } = await supabaseAdmin
      .from('programs')
      .insert({
        ...dataFields,
        tenant_id: tenantId,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/programs/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const payload = programSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;
    let query = supabaseAdmin
      .from('programs')
      .update({
        ...dataFields,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
      })
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id)
      .select();

    query = query.or(facilityScopeFilter(facilityId));

    const { data, error } = await query.single();
    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/programs/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    let query = supabaseAdmin
      .from('programs')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id);

    query = query.or(facilityScopeFilter(facilityId));

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/medications', async (req, res) => {
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;
  const includeInactive = readIncludeInactive(req);

  try {
    let query = supabaseAdmin
      .from('medication_master')
      .select('*')
      .eq('tenant_id', tenantId);

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    query = applyScopedFacilityFilter(query, facilityId);

    const { data, error } = await query.order('medication_name');
    if (error) throw error;

    const resolved = preferFacilityScopedRows(data || [], medicationIdentity).sort((left, right) =>
      left.medication_name.localeCompare(right.medication_name)
    );

    res.json(resolved);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/medications', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId, profileId } = scope;

  try {
    const payload = medicationSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;

    const { data, error } = await supabaseAdmin
      .from('medication_master')
      .insert({
        ...dataFields,
        tenant_id: tenantId,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
        created_by: profileId,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/medications/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const payload = medicationSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;

    let query = supabaseAdmin
      .from('medication_master')
      .update({
        ...dataFields,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
      })
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id)
      .select();

    query = query.or(facilityScopeFilter(facilityId));

    const { data, error } = await query.single();
    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/medications/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    let query = supabaseAdmin
      .from('medication_master')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id);

    query = query.or(facilityScopeFilter(facilityId));

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/lab-catalog', async (req, res) => {
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;
  const includeInactive = readIncludeInactive(req);

  try {
    let query = supabaseAdmin
      .from('lab_test_master')
      .select('*')
      .eq('tenant_id', tenantId);

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    query = applyScopedFacilityFilter(query, facilityId);

    const { data, error } = await query
      .order('category')
      .order('panel_name')
      .order('test_name');

    if (error) throw error;

    const resolved = preferFacilityScopedRows(data || [], labCatalogIdentity).sort((left, right) => {
      const categoryCompare = left.category.localeCompare(right.category);
      if (categoryCompare !== 0) return categoryCompare;
      return left.test_name.localeCompare(right.test_name);
    });

    res.json(resolved);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/lab-catalog', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId, profileId } = scope;

  try {
    const payload = labCatalogSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;

    const { data, error } = await supabaseAdmin
      .from('lab_test_master')
      .insert({
        ...dataFields,
        tenant_id: tenantId,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
        created_by: profileId,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/lab-catalog/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const payload = labCatalogSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;

    let query = supabaseAdmin
      .from('lab_test_master')
      .update({
        ...dataFields,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
      })
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id)
      .select();

    query = query.or(facilityScopeFilter(facilityId));

    const { data, error } = await query.single();
    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/lab-catalog/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    let query = supabaseAdmin
      .from('lab_test_master')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id);

    query = query.or(facilityScopeFilter(facilityId));

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/imaging', async (req, res) => {
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const { data, error } = await applyScopedFacilityFilter(
      supabaseAdmin
        .from('imaging_study_catalog')
        .select('*')
        .eq('tenant_id', tenantId),
      facilityId
    )
      .order('modality')
      .order('study_name');

    if (error) throw error;
    const resolved = preferFacilityScopedRows(data || [], imagingIdentity).sort((left, right) => {
      const modalityCompare = String(left.modality || '').localeCompare(String(right.modality || ''));
      if (modalityCompare !== 0) return modalityCompare;
      return String(left.study_name || '').localeCompare(String(right.study_name || ''));
    });
    res.json(resolved);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/imaging', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId, profileId } = scope;

  try {
    const payload = imagingSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;
    const { data, error } = await supabaseAdmin
      .from('imaging_study_catalog')
      .insert({
        ...dataFields,
        tenant_id: tenantId,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
        created_by: profileId,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/imaging/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const payload = imagingSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;
    let query = supabaseAdmin
      .from('imaging_study_catalog')
      .update({
        ...dataFields,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
      })
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id)
      .select();

    query = query.or(facilityScopeFilter(facilityId));

    const { data, error } = await query.single();
    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/imaging/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    let query = supabaseAdmin
      .from('imaging_study_catalog')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id);

    query = query.or(facilityScopeFilter(facilityId));

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/equipment', async (req, res) => {
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;
  const includeInactive = readIncludeInactive(req);

  try {
    let query = supabaseAdmin
      .from('equipment_master')
      .select('*')
      .eq('tenant_id', tenantId);

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    query = applyScopedFacilityFilter(query, facilityId);

    const { data, error } = await query.order('category').order('equipment_name');
    if (error) throw error;

    const resolved = preferFacilityScopedRows(data || [], equipmentIdentity).sort((left, right) => {
      const categoryCompare = left.category.localeCompare(right.category);
      if (categoryCompare !== 0) return categoryCompare;
      return left.equipment_name.localeCompare(right.equipment_name);
    });

    res.json(resolved);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/equipment', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId, profileId } = scope;

  try {
    const payload = equipmentSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;

    const { data, error } = await supabaseAdmin
      .from('equipment_master')
      .insert({
        ...dataFields,
        tenant_id: tenantId,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
        created_by: profileId,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/equipment/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    const payload = equipmentSchema.parse(req.body);
    const { scope: recordScope, ...dataFields } = payload;

    let query = supabaseAdmin
      .from('equipment_master')
      .update({
        ...dataFields,
        facility_id: resolveScopedFacilityId(recordScope, facilityId, 'tenant'),
      })
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id)
      .select();

    query = query.or(facilityScopeFilter(facilityId));

    const { data, error } = await query.single();
    if (error) throw error;

    res.json(data);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.issues });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/equipment/:id', async (req, res) => {
  if (!ensureMasterDataAdmin(req, res)) return;
  const scope = await requireMasterDataScope(req, res);
  if (!scope) return;

  const { tenantId, facilityId } = scope;

  try {
    let query = supabaseAdmin
      .from('equipment_master')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('id', req.params.id);

    query = query.or(facilityScopeFilter(facilityId));

    const { error } = await query;
    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
