import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';

const router = Router();
router.use(requireUser, requireScopedUser);

const limitSchema = z.object({
  limit: z.coerce.number().min(1).max(200).optional(),
});

const idsSchema = z.object({
  ids: z.string().min(1),
});

const triageUpdateSchema = z
  .object({
    temperature: z.number().optional().nullable(),
    weight: z.number().optional().nullable(),
    blood_pressure: z.string().optional().nullable(),
    heart_rate: z.number().int().optional().nullable(),
    respiratory_rate: z.number().int().optional().nullable(),
    oxygen_saturation: z.number().optional().nullable(),
    pain_score: z.number().int().optional().nullable(),
    triage_triggers: z.array(z.string()).optional().nullable(),
    triage_urgency: z.string().optional().nullable(),
    visit_notes: z.string().optional().nullable(),
    opd_room: z.string().optional().nullable(),
    assigned_doctor: z.string().uuid().optional().nullable(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'No update fields provided',
  });

const assessmentSchema = z.object({
  visitId: z.string().uuid(),
  patientId: z.string().uuid(),
  data: z.record(z.any()).optional(),
  existingRecordId: z.string().uuid().optional(),
});

const assessmentQuerySchema = z.object({
  visitId: z.string().uuid(),
  patientId: z.string().uuid().optional(),
});

const assessmentTables: Record<string, string> = {
  anc: 'anc_assessments',
  delivery: 'delivery_records',
  emergency: 'emergency_assessments',
  epi: 'immunization_records',
  family_planning: 'family_planning_visits',
  pediatric: 'pediatric_assessments',
};

const sanitizePayload = (payload: Record<string, any>) => {
  const {
    id,
    created_at,
    updated_at,
    created_by,
    facility_id,
    tenant_id,
    visit_id,
    patient_id,
    ...rest
  } = payload;
  return rest;
};

router.get('/departments', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('departments')
      .select('id, name')
      .eq('is_active', true)
      .or(`facility_id.is.null,facility_id.eq.${facilityId}`)
      .order('name');

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_departments',
        eventType: 'read',
        entityType: 'department',
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length },
      });
    }

    return res.json({ items: data || [] });
  } catch (error: any) {
    console.error('Departments list error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load departments' });
  }
});

router.get('/queue', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  const parsed = limitSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const limit = parsed.data.limit ?? 50;

  try {
    const { data, error } = await supabaseAdmin
      .from('nurse_dashboard_queue')
      .select('*')
      .eq('facility_id', facilityId)
      .order('visit_date', { ascending: false })
      .limit(limit);

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_nurse_queue',
        eventType: 'read',
        entityType: 'visit_list',
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length, limit },
      });
    }

    return res.json({ visits: data || [] });
  } catch (error: any) {
    console.error('Nurse queue error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load nurse queue' });
  }
});

router.get('/visits/pain-scores', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  const parsed = idsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const ids = parsed.data.ids
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return res.json({ items: [] });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('visits')
      .select('id, pain_score')
      .eq('facility_id', facilityId)
      .in('id', ids);

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_pain_scores',
        eventType: 'read',
        entityType: 'visit',
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length },
      });
    }

    return res.json({ items: data || [] });
  } catch (error: any) {
    console.error('Pain score lookup error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load pain scores' });
  }
});

router.get('/visits/active', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabaseAdmin
      .from('visits')
      .select('id, created_at, status, status_updated_at, journey_timeline')
      .eq('facility_id', facilityId)
      .gte('visit_date', today)
      .in('status', [
        'registered',
        'vitals_taken',
        'at_triage',
        'with_doctor',
        'paying_consultation',
        'paying_diagnosis',
      ]);

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_active_visits',
        eventType: 'read',
        entityType: 'visit_list',
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length },
      });
    }

    return res.json({ visits: data || [] });
  } catch (error: any) {
    console.error('Active visits error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load active visits' });
  }
});

router.get('/visits/:id/payment-status', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const visitId = req.params.id;

  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  try {
    const { data: visitRow, error: visitError } = await supabaseAdmin
      .from('visits')
      .select('id, facility_id')
      .eq('id', visitId)
      .maybeSingle();

    if (visitError) throw visitError;
    if (!visitRow) return res.status(404).json({ error: 'Visit not found' });
    if (visitRow.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });

    const { data, error } = await supabaseAdmin
      .from('visit_payment_status')
      .select('consultation_payment_status, overall_payment_status, has_unpaid_items, last_payment_at')
      .eq('visit_id', visitId)
      .maybeSingle();

    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_payment_status',
        eventType: 'read',
        entityType: 'visit_payment_status',
        entityId: visitId,
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
      });
    }

    return res.json({
      consultation_payment_status: data?.consultation_payment_status || null,
      overall_payment_status: data?.overall_payment_status || null,
      has_unpaid_items: Boolean(data?.has_unpaid_items),
      last_payment_at: data?.last_payment_at || null,
    });
  } catch (error: any) {
    console.error('Payment status error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load payment status' });
  }
});

router.post('/visits/:id/triage', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const visitId = req.params.id;
  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  const parsed = triageUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { data: visitRow, error: visitError } = await supabaseAdmin
      .from('visits')
      .select('id, facility_id')
      .eq('id', visitId)
      .maybeSingle();

    if (visitError) throw visitError;
    if (!visitRow) return res.status(404).json({ error: 'Visit not found' });
    if (visitRow.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });

    const { data, error } = await supabaseAdmin
      .from('visits')
      .update(parsed.data)
      .eq('id', visitId)
      .select('id')
      .single();

    if (error || !data) {
      return res.status(500).json({ error: error?.message || 'Failed to update visit' });
    }

    if (tenantId) {
      await recordAuditEvent({
        action: 'update_triage',
        eventType: 'update',
        entityType: 'visit',
        entityId: visitId,
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: {
          fields: Object.keys(parsed.data),
        },
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Triage update error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to update triage data' });
  }
});

router.post('/assessments/:type', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const type = req.params.type;
  const tableName = assessmentTables[type];

  if (!tableName) {
    return res.status(404).json({ error: 'Unknown assessment type' });
  }

  if (!facilityId || !tenantId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  const parsed = assessmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { visitId, patientId, data, existingRecordId } = parsed.data;

  try {
    const { data: visitRow, error: visitError } = await supabaseAdmin
      .from('visits')
      .select('id, facility_id')
      .eq('id', visitId)
      .maybeSingle();

    if (visitError) throw visitError;
    if (!visitRow) return res.status(404).json({ error: 'Visit not found' });
    if (visitRow.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });

    const basePayload = {
      ...sanitizePayload(data || {}),
      visit_id: visitId,
      patient_id: patientId,
      facility_id: facilityId,
      tenant_id: tenantId,
    };

    if (existingRecordId) {
      const { error } = await supabaseAdmin
        .from(tableName)
        .update(basePayload)
        .eq('id', existingRecordId);

      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin
        .from(tableName)
        .insert({ ...basePayload, created_by: profileId || null });
      if (error) throw error;
    }

    if (tenantId) {
      await recordAuditEvent({
        action: 'save_assessment',
        eventType: existingRecordId ? 'update' : 'create',
        entityType: 'assessment',
        entityId: existingRecordId || null,
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { type },
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Assessment save error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to save assessment' });
  }
});

router.get('/assessments/:type', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const type = req.params.type;
  const tableName = assessmentTables[type];

  if (!tableName) {
    return res.status(404).json({ error: 'Unknown assessment type' });
  }

  if (!facilityId) {
    return res.status(400).json({ error: 'Missing facility context' });
  }

  const parsed = assessmentQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const { visitId, patientId } = parsed.data;

  try {
    let query = supabaseAdmin
      .from(tableName)
      .select('*')
      .eq('visit_id', visitId)
      .eq('facility_id', facilityId);

    if (patientId) {
      query = query.eq('patient_id', patientId);
    }

    const { data, error } = await query.maybeSingle();
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_assessment',
        eventType: 'read',
        entityType: 'assessment',
        entityId: data?.id || null,
        tenantId,
        facilityId,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { type },
      });
    }

    return res.json({ item: data || null });
  } catch (error: any) {
    console.error('Assessment fetch error:', error?.message || error);
    return res.status(500).json({ error: error.message || 'Failed to load assessment' });
  }
});

export default router;
