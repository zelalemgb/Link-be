import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';

const router = Router();
router.use(requireUser, requireScopedUser);

const countsQuerySchema = z.object({
  visitIds: z.string().optional(),
});

const recentMedsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(20).optional(),
});

const bulkUpdateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  updates: z
    .record(z.any())
    .refine((value) => Object.keys(value).length > 0, {
      message: 'updates must include at least one field',
    }),
});

const labCreateSchema = z.object({
  visitId: z.string().uuid(),
  patientId: z.string().uuid(),
  orders: z.array(
    z.object({
      test_name: z.string().min(1),
      test_code: z.string().optional().nullable(),
      reference_range: z.string().optional().nullable(),
      urgency: z.string().optional().nullable(),
      amount: z.number().optional().nullable(),
      notes: z.string().optional().nullable(),
    })
  ).min(1),
});

const imagingCreateSchema = z.object({
  visitId: z.string().uuid(),
  patientId: z.string().uuid(),
  orders: z.array(
    z.object({
      study_name: z.string().min(1),
      study_code: z.string().optional().nullable(),
      body_part: z.string().optional().nullable(),
      urgency: z.string().optional().nullable(),
      amount: z.number().optional().nullable(),
      notes: z.string().optional().nullable(),
    })
  ).min(1),
});

const medicationCreateSchema = z.object({
  visitId: z.string().uuid(),
  patientId: z.string().uuid(),
  orders: z.array(
    z.object({
      medication_name: z.string().min(1),
      generic_name: z.string().optional().nullable(),
      dosage: z.string().min(1),
      frequency: z.string().min(1),
      route: z.string().min(1),
      duration: z.string().optional().nullable(),
      quantity: z.number().optional().nullable(),
      refills: z.number().optional().nullable(),
      amount: z.number().optional().nullable(),
      notes: z.string().optional().nullable(),
    })
  ).min(1),
});

const procedureCreateSchema = z.object({
  visitId: z.string().uuid(),
  patientId: z.string().uuid(),
  serviceId: z.string().uuid(),
  quantity: z.number().min(1).optional(),
  unitPrice: z.number().min(0),
  notes: z.string().optional().nullable(),
});

const templateCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  template_data: z.record(z.any()),
  is_shared: z.boolean().optional(),
});

const mapLabTestStatus = (row: any): 'In Progress' | 'Results Entered' | 'Verified' | 'Released' => {
  if (row.status === 'completed') return 'Released';
  if (row.status === 'verified') return 'Verified';
  if (row.result_value || row.result) return 'Results Entered';
  return 'In Progress';
};

const deriveLabPatientStatus = (tests: Array<{ status: string; collected_at?: string | null; result?: string | null; result_value?: string | null }>) => {
  if (tests.length === 0) return 'Not Collected';
  if (tests.every((t) => t.status === 'completed')) return 'Released';
  if (tests.some((t) => t.status === 'verified')) return 'Verified';
  if (tests.some((t) => t.result || t.result_value)) return 'Results Entered';
  if (tests.some((t) => t.collected_at)) return 'Collected';
  return 'Not Collected';
};

const parseAccession = (note?: string | null) => {
  if (!note) return null;
  const match = note.match(/Accession:\s*([A-Za-z0-9-]+)/i);
  return match?.[1] || null;
};

const parseCollector = (note?: string | null) => {
  if (!note) return null;
  const match = note.match(/Sample collected by ([^\.]+)\./i);
  return match?.[1]?.trim() || null;
};

router.get('/counts', async (req, res) => {
  const { tenantId, facilityId, profileId, role } = req.user!;
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
    const { facilityId, tenantId } = req.user!;
    let visitQuery = supabaseAdmin
      .from('visits')
      .select('id')
      .in('id', visitIds);

    if (tenantId) {
      visitQuery = visitQuery.eq('tenant_id', tenantId);
    }
    if (facilityId) {
      visitQuery = visitQuery.eq('facility_id', facilityId);
    }

    const { data: scopedVisits, error: visitError } = await visitQuery;
    if (visitError) throw visitError;

    const scopedVisitIds = (scopedVisits || []).map((visit) => visit.id);
    if (scopedVisitIds.length === 0) {
      return res.json({ counts: {} });
    }

    const [labResult, imagingResult, medicationResult] = await Promise.all([
      supabaseAdmin
        .from('lab_orders')
        .select('visit_id, status, result')
        .in('visit_id', scopedVisitIds),
      supabaseAdmin
        .from('imaging_orders')
        .select('visit_id, status, result')
        .in('visit_id', scopedVisitIds),
      supabaseAdmin
        .from('medication_orders')
        .select('visit_id, status')
        .in('visit_id', scopedVisitIds),
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

    scopedVisitIds.forEach((visitId) => {
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

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_order_counts',
        eventType: 'read',
        entityType: 'order_counts',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { visit_count: scopedVisitIds.length },
      });
    }

    return res.json({ counts });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unable to fetch order counts' });
  }
});

/**
 * GET /api/orders/lab
 * Returns lab orders grouped by patient visit for lab dashboard.
 */
router.get('/lab', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;

  try {
    let query = supabaseAdmin
      .from('lab_orders')
      .select(
        `
          id,
          visit_id,
          patient_id,
          test_name,
          test_code,
          result,
          result_value,
          reference_range,
          status,
          notes,
          urgency,
          ordered_at,
          payment_status,
          amount,
          paid_at,
          sample_type,
          collected_at,
          visits!inner(
            id,
            created_at,
            routing_status,
            journey_timeline,
            current_journey_stage,
            patients (
              id,
              full_name,
              age,
              gender
            )
          )
        `
      )
      .order('ordered_at', { ascending: false });

    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    }
    if (facilityId) {
      query = query.eq('visits.facility_id', facilityId);
    }

    const { data, error } = await query;
    if (error) throw error;

    const patientMap = new Map<string, any>();

    (data || []).forEach((row: any) => {
      const visit = row.visits;
      if (!visit) return;
      const visitId = visit.id;
      const patient = visit.patients;

      if (!patientMap.has(visitId)) {
        patientMap.set(visitId, {
          id: visitId,
          patient_id: row.patient_id,
          name: patient?.full_name || 'Unknown',
          age: patient?.age || 0,
          sex: patient?.gender === 'female' ? 'Female' : 'Male',
          urgency: row.urgency === 'stat' ? 'STAT' : 'Routine',
          accession: null,
          sampleType: row.sample_type || null,
          collector: parseCollector(row.notes),
          collectedAt: row.collected_at || null,
          status: 'Not Collected',
          tests: [],
          uncollectedCount: 0,
          current_journey_stage: visit.current_journey_stage || null,
          routing_status: visit.routing_status || null,
          journey_timeline: visit.journey_timeline || null,
          created_at: visit.created_at || null,
          payment_status: row.payment_status || null,
        });
      }

      const entry = patientMap.get(visitId);
      if (row.urgency === 'stat') {
        entry.urgency = 'STAT';
      }

      if (!entry.accession) {
        entry.accession = parseAccession(row.notes);
      }

      if (!entry.collector) {
        entry.collector = parseCollector(row.notes);
      }

      if (!entry.collectedAt && row.collected_at) {
        entry.collectedAt = row.collected_at;
      }

      entry.tests.push({
        id: row.id,
        test_name: row.test_name,
        test_code: row.test_code || undefined,
        result: row.result_value || row.result || undefined,
        result_value: row.result_value || undefined,
        reference_range: row.reference_range || '',
        status: mapLabTestStatus(row),
        notes: row.notes || undefined,
        urgency: row.urgency === 'stat' ? 'STAT' : 'Routine',
        ordered_at: row.ordered_at,
        payment_status: row.payment_status || null,
        amount: row.amount || undefined,
        paid_at: row.paid_at || undefined,
        sample_type: row.sample_type || undefined,
        collected_at: row.collected_at || undefined,
      });
    });

    patientMap.forEach((entry) => {
      const tests = entry.tests as any[];
      entry.status = deriveLabPatientStatus(tests.map((t) => ({
        status: t.status === 'Released' ? 'completed' : t.status === 'Verified' ? 'verified' : t.result ? 'pending' : 'pending',
        collected_at: t.collected_at,
        result: t.result,
        result_value: t.result_value,
      })));

      entry.uncollectedCount = tests.filter((t) => !t.collected_at).length;
    });

    const patients = Array.from(patientMap.values());

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_lab_orders',
        eventType: 'read',
        entityType: 'lab_orders',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: patients.length },
      });
    }

    return res.json({ patients });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unable to fetch lab orders' });
  }
});

/**
 * GET /api/orders/medications/recent
 * Returns recently ordered medications for the current user.
 */
router.get('/medications/recent', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = recentMedsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  if (!profileId) {
    return res.status(400).json({ error: 'Missing user context' });
  }

  const limit = parsed.data.limit ?? 10;

  try {
    let query = supabaseAdmin
      .from('medication_orders')
      .select('medication_name, generic_name, dosage, route, frequency, ordered_at')
      .eq('ordered_by', profileId)
      .order('ordered_at', { ascending: false })
      .limit(limit);

    if (facilityId) {
      query = query.eq('facility_id', facilityId);
    }
    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    }

    const { data, error } = await query;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_recent_medications',
        eventType: 'read',
        entityType: 'medication_orders',
        tenantId,
        facilityId: facilityId || null,
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
    return res.status(500).json({ error: error.message || 'Failed to fetch recent medications' });
  }
});

/**
 * GET /api/orders/medications
 * Returns medication orders with patient context for pharmacy dashboard.
 */
router.get('/medications', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;

  try {
    let query = supabaseAdmin
      .from('medication_orders')
      .select(
        `
          id,
          visit_id,
          patient_id,
          ordered_by,
          medication_name,
          generic_name,
          dosage,
          frequency,
          route,
          duration,
          quantity,
          refills,
          status,
          notes,
          ordered_at,
          dispensed_at,
          payment_status,
          payment_mode,
          amount,
          paid_at,
          sent_outside,
          tenant_id,
          visits!inner(
            id,
            created_at,
            routing_status,
            journey_timeline,
            current_journey_stage,
            patients (
              full_name,
              age,
              gender
            )
          )
        `
      )
      .order('ordered_at', { ascending: false });

    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    }
    if (facilityId) {
      query = query.eq('facility_id', facilityId);
    }

    const { data, error } = await query;
    if (error) throw error;

    const orderRows = data || [];
    const orderedByIds = [...new Set(orderRows.map((row: any) => row.ordered_by).filter(Boolean))];
    const medicationNames = [...new Set(orderRows.map((row: any) => row.medication_name).filter(Boolean))];
    const genericNames = [...new Set(orderRows.map((row: any) => row.generic_name).filter(Boolean))];

    const [userResult, stockResult] = await Promise.all([
      orderedByIds.length
        ? supabaseAdmin.from('users').select('id, name').in('id', orderedByIds)
        : Promise.resolve({ data: [] as any[], error: null }),
      facilityId
        ? supabaseAdmin
            .from('current_stock')
            .select('name, generic_name, current_quantity, reorder_level')
            .eq('facility_id', facilityId)
        : Promise.resolve({ data: [] as any[], error: null }),
    ]);

    if (userResult.error) throw userResult.error;
    if (stockResult.error) throw stockResult.error;

    const userMap = new Map((userResult.data || []).map((u: any) => [u.id, u.name]));
    const stockMap = new Map<string, { current_quantity: number | null; reorder_level: number | null }>();

    (stockResult.data || []).forEach((row: any) => {
      if (row.name) {
        stockMap.set(row.name.toLowerCase(), {
          current_quantity: row.current_quantity,
          reorder_level: row.reorder_level,
        });
      }
      if (row.generic_name) {
        stockMap.set(row.generic_name.toLowerCase(), {
          current_quantity: row.current_quantity,
          reorder_level: row.reorder_level,
        });
      }
    });

    const orders = orderRows.map((row: any) => {
      const stockKey = (row.generic_name || row.medication_name || '').toLowerCase();
      const stock = stockMap.get(stockKey);
      return {
        id: row.id,
        visit_id: row.visit_id,
        patient_id: row.patient_id,
        ordered_by: row.ordered_by,
        medication_name: row.medication_name,
        generic_name: row.generic_name,
        dosage: row.dosage,
        frequency: row.frequency,
        route: row.route,
        duration: row.duration,
        quantity: row.quantity,
        refills: row.refills,
        status: row.status,
        notes: row.notes,
        ordered_at: row.ordered_at,
        dispensed_at: row.dispensed_at,
        payment_status: row.payment_status,
        payment_mode: row.payment_mode,
        amount: row.amount,
        paid_at: row.paid_at,
        sent_outside: row.sent_outside,
        tenant_id: row.tenant_id,
        patient_full_name: row.visits?.patients?.full_name || 'Unknown',
        patient_age: row.visits?.patients?.age || 0,
        patient_gender: row.visits?.patients?.gender || 'Unknown',
        prescriber_name: userMap.get(row.ordered_by) || null,
        stock_on_hand: stock?.current_quantity ?? null,
        reorder_level: stock?.reorder_level ?? null,
        current_journey_stage: row.visits?.current_journey_stage || null,
        routing_status: row.visits?.routing_status || null,
        journey_timeline: row.visits?.journey_timeline || null,
        created_at: row.visits?.created_at || null,
      };
    });

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_medication_orders',
        eventType: 'read',
        entityType: 'medication_orders',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: orders.length },
      });
    }

    return res.json({ orders });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unable to fetch medication orders' });
  }
});

router.post('/lab', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = labCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { visitId, patientId, orders } = parsed.data;

  try {
    const { data: visitRow, error: visitError } = await supabaseAdmin
      .from('visits')
      .select('id, facility_id, tenant_id')
      .eq('id', visitId)
      .maybeSingle();

    if (visitError) throw visitError;
    if (!visitRow) return res.status(404).json({ error: 'Visit not found' });
    if (facilityId && visitRow.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });
    if (tenantId && visitRow.tenant_id !== tenantId) return res.status(403).json({ error: 'Forbidden' });

    const { data: existing } = await supabaseAdmin
      .from('lab_orders')
      .select('test_name')
      .eq('visit_id', visitId);

    const existingSet = new Set((existing || []).map((row: any) => row.test_name?.toLowerCase()));
    const toInsert = orders.filter((order) => !existingSet.has(order.test_name.toLowerCase()));
    const skipped = orders.length - toInsert.length;

    if (toInsert.length === 0) {
      return res.json({ inserted: 0, skipped });
    }

    const payload = toInsert.map((order) => ({
      visit_id: visitId,
      patient_id: patientId,
      ordered_by: profileId,
      tenant_id: tenantId,
      facility_id: facilityId,
      test_name: order.test_name,
      test_code: order.test_code || null,
      reference_range: order.reference_range || null,
      urgency: order.urgency || 'routine',
      status: 'pending',
      payment_status: 'unpaid',
      amount: order.amount || null,
      notes: order.notes || null,
    }));

    const { error: insertError } = await supabaseAdmin.from('lab_orders').insert(payload);
    if (insertError) throw insertError;

    if (tenantId) {
      await recordAuditEvent({
        action: 'create_lab_orders',
        eventType: 'create',
        entityType: 'lab_orders',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { inserted: payload.length, skipped },
      });
    }

    return res.json({ inserted: payload.length, skipped });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to create lab orders' });
  }
});

router.post('/imaging', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = imagingCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { visitId, patientId, orders } = parsed.data;

  try {
    const { data: visitRow, error: visitError } = await supabaseAdmin
      .from('visits')
      .select('id, facility_id, tenant_id')
      .eq('id', visitId)
      .maybeSingle();

    if (visitError) throw visitError;
    if (!visitRow) return res.status(404).json({ error: 'Visit not found' });
    if (facilityId && visitRow.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });
    if (tenantId && visitRow.tenant_id !== tenantId) return res.status(403).json({ error: 'Forbidden' });

    const { data: existing } = await supabaseAdmin
      .from('imaging_orders')
      .select('study_name')
      .eq('visit_id', visitId);

    const existingSet = new Set((existing || []).map((row: any) => row.study_name?.toLowerCase()));
    const toInsert = orders.filter((order) => !existingSet.has(order.study_name.toLowerCase()));
    const skipped = orders.length - toInsert.length;

    if (toInsert.length === 0) {
      return res.json({ inserted: 0, skipped });
    }

    const payload = toInsert.map((order) => ({
      visit_id: visitId,
      patient_id: patientId,
      ordered_by: profileId,
      tenant_id: tenantId,
      facility_id: facilityId,
      study_name: order.study_name,
      study_code: order.study_code || null,
      body_part: order.body_part || null,
      urgency: order.urgency || 'routine',
      status: 'pending',
      payment_status: 'unpaid',
      amount: order.amount || null,
      notes: order.notes || null,
    }));

    const { error: insertError } = await supabaseAdmin.from('imaging_orders').insert(payload);
    if (insertError) throw insertError;

    if (tenantId) {
      await recordAuditEvent({
        action: 'create_imaging_orders',
        eventType: 'create',
        entityType: 'imaging_orders',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { inserted: payload.length, skipped },
      });
    }

    return res.json({ inserted: payload.length, skipped });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to create imaging orders' });
  }
});

router.post('/medications', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = medicationCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { visitId, patientId, orders } = parsed.data;

  try {
    const { data: visitRow, error: visitError } = await supabaseAdmin
      .from('visits')
      .select('id, facility_id, tenant_id')
      .eq('id', visitId)
      .maybeSingle();

    if (visitError) throw visitError;
    if (!visitRow) return res.status(404).json({ error: 'Visit not found' });
    if (facilityId && visitRow.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });
    if (tenantId && visitRow.tenant_id !== tenantId) return res.status(403).json({ error: 'Forbidden' });

    const { data: existing } = await supabaseAdmin
      .from('medication_orders')
      .select('medication_name, dosage, frequency')
      .eq('visit_id', visitId);

    const existingSet = new Set(
      (existing || []).map((row: any) => `${row.medication_name?.toLowerCase()}-${row.dosage}-${row.frequency}`)
    );

    const toInsert = orders.filter((order) => {
      const key = `${order.medication_name.toLowerCase()}-${order.dosage}-${order.frequency}`;
      return !existingSet.has(key);
    });
    const skipped = orders.length - toInsert.length;

    if (toInsert.length === 0) {
      return res.json({ inserted: 0, skipped });
    }

    const payload = toInsert.map((order) => ({
      visit_id: visitId,
      patient_id: patientId,
      ordered_by: profileId,
      tenant_id: tenantId,
      facility_id: facilityId,
      medication_name: order.medication_name,
      generic_name: order.generic_name || null,
      dosage: order.dosage,
      frequency: order.frequency,
      route: order.route,
      duration: order.duration || null,
      quantity: order.quantity || null,
      refills: order.refills || null,
      status: 'pending',
      payment_status: 'unpaid',
      amount: order.amount || null,
      notes: order.notes || null,
    }));

    const { error: insertError } = await supabaseAdmin.from('medication_orders').insert(payload);
    if (insertError) throw insertError;

    if (tenantId) {
      await recordAuditEvent({
        action: 'create_medication_orders',
        eventType: 'create',
        entityType: 'medication_orders',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { inserted: payload.length, skipped },
      });
    }

    return res.json({ inserted: payload.length, skipped });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to create medication orders' });
  }
});

router.post('/procedures', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = procedureCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { visitId, patientId, serviceId, quantity = 1, unitPrice, notes } = parsed.data;

  try {
    const { data: visitRow, error: visitError } = await supabaseAdmin
      .from('visits')
      .select('id, facility_id, tenant_id')
      .eq('id', visitId)
      .maybeSingle();

    if (visitError) throw visitError;
    if (!visitRow) return res.status(404).json({ error: 'Visit not found' });
    if (facilityId && visitRow.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });
    if (tenantId && visitRow.tenant_id !== tenantId) return res.status(403).json({ error: 'Forbidden' });

    const { error: insertError } = await supabaseAdmin
      .from('billing_items')
      .insert({
        visit_id: visitId,
        tenant_id: tenantId,
        patient_id: patientId,
        service_id: serviceId,
        quantity,
        unit_price: unitPrice,
        total_amount: unitPrice * quantity,
        created_by: profileId,
        payment_status: 'unpaid',
        notes: notes || null,
      } as any);

    if (insertError) throw insertError;

    if (tenantId) {
      await recordAuditEvent({
        action: 'create_procedure_order',
        eventType: 'create',
        entityType: 'billing_item',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to create procedure order' });
  }
});

router.post('/lab/bulk', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = bulkUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { ids, updates } = parsed.data;

  try {
    let query = supabaseAdmin.from('lab_orders').update(updates).in('id', ids);
    if (facilityId) {
      query = query.eq('facility_id', facilityId);
    }
    const { error } = await query;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'update_lab_orders',
        eventType: 'update',
        entityType: 'lab_orders',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { count: ids.length, fields: Object.keys(updates) },
      });
    }

    return res.json({ success: true, updated: ids.length });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to update lab orders' });
  }
});

router.patch('/lab/:id', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const id = req.params.id;
  const updates = req.body || {};

  if (!updates || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  try {
    let query = supabaseAdmin.from('lab_orders').update(updates).eq('id', id);
    if (facilityId) {
      query = query.eq('facility_id', facilityId);
    }
    const { error } = await query;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'update_lab_order',
        eventType: 'update',
        entityType: 'lab_order',
        entityId: id,
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { fields: Object.keys(updates) },
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to update lab order' });
  }
});

router.delete('/lab/:id', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const id = req.params.id;

  try {
    const { data: order, error: fetchError } = await supabaseAdmin
      .from('lab_orders')
      .select('id, facility_id, tenant_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!order) return res.status(404).json({ error: 'Lab order not found' });
    if (facilityId && order.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });
    if (tenantId && order.tenant_id !== tenantId) return res.status(403).json({ error: 'Forbidden' });

    const { error } = await supabaseAdmin.from('lab_orders').delete().eq('id', id);
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'delete_lab_order',
        eventType: 'delete',
        entityType: 'lab_order',
        entityId: id,
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to delete lab order' });
  }
});

router.patch('/imaging/:id', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const id = req.params.id;
  const updates = req.body || {};

  if (!updates || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  try {
    let query = supabaseAdmin.from('imaging_orders').update(updates).eq('id', id);
    if (facilityId) {
      query = query.eq('facility_id', facilityId);
    }
    const { error } = await query;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'update_imaging_order',
        eventType: 'update',
        entityType: 'imaging_order',
        entityId: id,
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { fields: Object.keys(updates) },
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to update imaging order' });
  }
});

router.delete('/imaging/:id', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const id = req.params.id;

  try {
    const { data: order, error: fetchError } = await supabaseAdmin
      .from('imaging_orders')
      .select('id, facility_id, tenant_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!order) return res.status(404).json({ error: 'Imaging order not found' });
    if (facilityId && order.facility_id !== facilityId) return res.status(403).json({ error: 'Forbidden' });
    if (tenantId && order.tenant_id !== tenantId) return res.status(403).json({ error: 'Forbidden' });

    const { error } = await supabaseAdmin.from('imaging_orders').delete().eq('id', id);
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'delete_imaging_order',
        eventType: 'delete',
        entityType: 'imaging_order',
        entityId: id,
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to delete imaging order' });
  }
});

router.patch('/medications/:id', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const id = req.params.id;
  const updates = req.body || {};

  if (!updates || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  try {
    let query = supabaseAdmin.from('medication_orders').update(updates).eq('id', id);
    if (facilityId) {
      query = query.eq('facility_id', facilityId);
    }
    const { error } = await query;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'update_medication_order',
        eventType: 'update',
        entityType: 'medication_order',
        entityId: id,
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { fields: Object.keys(updates) },
      });
    }

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to update medication order' });
  }
});

router.post('/medications/bulk', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = bulkUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { ids, updates } = parsed.data;

  try {
    let query = supabaseAdmin.from('medication_orders').update(updates).in('id', ids);
    if (facilityId) {
      query = query.eq('facility_id', facilityId);
    }
    const { error } = await query;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'bulk_update_medications',
        eventType: 'update',
        entityType: 'medication_orders',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { count: ids.length, fields: Object.keys(updates) },
      });
    }

    return res.json({ success: true, updated: ids.length });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to update medication orders' });
  }
});

router.get('/imaging/templates', async (req, res) => {
  const { tenantId, facilityId, profileId } = req.user!;
  if (!tenantId) return res.status(400).json({ error: 'Missing tenant context' });

  try {
    let query = supabaseAdmin
      .from('imaging_order_templates')
      .select('*')
      .eq('tenant_id', tenantId);

    // Allow shared templates for facility and personal templates
    if (facilityId) {
      query = query.or(`created_by.eq.${profileId},is_shared.eq.true`);
    } else {
      query = query.eq('created_by', profileId);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ templates: data || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load templates' });
  }
});

router.post('/imaging/templates', async (req, res) => {
  const { tenantId, facilityId, profileId } = req.user!;
  if (!tenantId || !profileId) return res.status(400).json({ error: 'Missing user context' });

  const parsed = templateCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  const { name, description, template_data, is_shared } = parsed.data;

  try {
    const { error } = await supabaseAdmin
      .from('imaging_order_templates')
      .insert({
        name,
        description: description || null,
        template_data,
        created_by: profileId,
        tenant_id: tenantId,
        facility_id: is_shared ? facilityId : null,
        is_shared: is_shared ?? false,
      });

    if (error) throw error;

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to save template' });
  }
});

router.delete('/imaging/templates/:id', async (req, res) => {
  const { tenantId, profileId } = req.user!;
  const id = req.params.id;

  if (!tenantId || !profileId) return res.status(400).json({ error: 'Missing user context' });

  try {
    const { data: template, error: fetchError } = await supabaseAdmin
      .from('imaging_order_templates')
      .select('id, created_by, tenant_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!template) return res.status(404).json({ error: 'Template not found' });
    if (template.tenant_id !== tenantId || template.created_by !== profileId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { error } = await supabaseAdmin.from('imaging_order_templates').delete().eq('id', id);
    if (error) throw error;

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to delete template' });
  }
});

router.get('/imaging', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;

  try {
    let query = supabaseAdmin
      .from('imaging_orders')
      .select(`
        *,
        visits:visits!inner(
          id,
          patient_id,
          visit_date,
          reason,
          created_at,
          status,
          routing_status,
          journey_timeline,
          notes,
          current_journey_stage,
          patients (
            id,
            full_name,
            age,
            gender,
            phone
          )
        )
      `)
      .order('ordered_at', { ascending: false });

    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    }
    if (facilityId) {
      query = query.eq('visits.facility_id', facilityId);
    }

    const { data, error } = await query;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_imaging_orders',
        eventType: 'read',
        entityType: 'imaging_orders',
        tenantId,
        facilityId: facilityId || null,
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

    return res.json({ orders: data || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Unable to fetch imaging orders' });
  }
});

export default router;
