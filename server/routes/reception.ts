import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';

const router = Router();
router.use(requireUser, requireScopedUser);

const visitsQuerySchema = z.object({
  dateFilter: z.string().optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
});

const searchSchema = z.object({
  q: z.string().min(1),
});

const statusUpdateSchema = z.object({
  status: z.string(),
});

const feeUpdateSchema = z.object({
  feePaid: z.number(),
});

const appointmentUpdateSchema = z.object({
  status: z.enum(['checked_in', 'no_show', 'rescheduled']),
});

const visitSelection = `
  id,
  patient_id,
  visit_date,
  reason,
  provider,
  fee_paid,
  status,
  created_at,
  status_updated_at,
  journey_timeline,
  consultation_payment_type,
  insurance_provider,
  insurance_policy_number,
  patients (
    id,
    full_name,
    phone,
    age,
    gender
  )
`;

router.get('/visits', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = visitsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const { dateFilter, page = 1, pageSize = 10 } = parsed.data;
  const offset = (page - 1) * pageSize;

  try {
    let query = supabaseAdmin
      .from('visits')
      .select(visitSelection, { count: 'exact' })
      .eq('facility_id', facilityId)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (dateFilter === 'today') {
      const today = new Date().toISOString().split('T')[0];
      query = query.eq('visit_date', today);
    } else if (dateFilter === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      query = query.eq('visit_date', yesterday.toISOString().split('T')[0]);
    } else if (dateFilter === 'day_before_yesterday') {
      const dayBeforeYesterday = new Date();
      dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
      query = query.eq('visit_date', dayBeforeYesterday.toISOString().split('T')[0]);
    } else if (dateFilter === 'week') {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      query = query.gte('visit_date', weekAgo.toISOString().split('T')[0]);
    } else if (dateFilter === 'month') {
      const monthAgo = new Date();
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      query = query.gte('visit_date', monthAgo.toISOString().split('T')[0]);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_reception_visits',
        eventType: 'read',
        entityType: 'visit_list',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: (data || []).length, total_count: count ?? 0 },
      });
    }

    return res.json({
      visits: data || [],
      totalCount: count ?? 0,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load visits' });
  }
});

router.get('/visits/weekly', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const limit = Number(req.query.limit) || 100;
  try {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const { data, error } = await supabaseAdmin
      .from('visits')
      .select(visitSelection)
      .eq('facility_id', facilityId)
      .gte('visit_date', weekStart.toISOString().split('T')[0])
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (tenantId) {
      await recordAuditEvent({
        action: 'view_reception_weekly_visits',
        eventType: 'read',
        entityType: 'visit_list',
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

    return res.json({ visits: data || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load weekly visits' });
  }
});

router.get('/metrics/today', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  try {
    const todayDate = new Date().toISOString().split('T')[0];

    const [countResult, waitResult] = await Promise.all([
      supabaseAdmin
        .from('visits')
        .select('id', { count: 'exact', head: true })
        .eq('facility_id', facilityId)
        .eq('visit_date', todayDate),
      supabaseAdmin
        .from('visits')
        .select('id, created_at, status, status_updated_at')
        .eq('facility_id', facilityId)
        .eq('visit_date', todayDate)
        .order('created_at', { ascending: true })
        .limit(500),
    ]);

    if (countResult.error) throw countResult.error;
    if (waitResult.error) throw waitResult.error;

    const waitRows = (waitResult.data || []) as Array<{
      created_at: string;
      status: string | null;
      status_updated_at: string | null;
    }>;

    const activeRows = waitRows.filter((row) => {
      const status = (row.status || '').toLowerCase();
      return status !== 'discharged' && status !== 'cancelled';
    });

    const totalWaitMinutes = activeRows.reduce((sum, row) => {
      const reference = row.status_updated_at || row.created_at;
      if (!reference) return sum;
      const minutes = (Date.now() - new Date(reference).getTime()) / 60000;
      return sum + Math.max(0, minutes);
    }, 0);

    const averageWait = activeRows.length > 0 ? Math.round(totalWaitMinutes / activeRows.length) : 0;

    if (tenantId) {
      await recordAuditEvent({
        action: 'view_reception_metrics',
        eventType: 'read',
        entityType: 'visit_metrics',
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

    return res.json({
      visitCount: countResult.count || 0,
      averageWait,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to load metrics' });
  }
});

router.get('/search', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  const { q } = parsed.data;
  try {
    const { data: patients, error: patientsError } = await supabaseAdmin
      .from('patients')
      .select('id, full_name, age, gender, phone, date_of_birth, created_at')
      .eq('facility_id', facilityId)
      .or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`)
      .limit(50);

    if (patientsError) throw patientsError;

    if (!patients || patients.length === 0) {
      return res.json({ visits: [] });
    }

    const patientIds = patients.map((p) => p.id);
    const { data: visits, error: visitsError } = await supabaseAdmin
      .from('visits')
      .select('id, patient_id, status, visit_date, reason, provider, fee_paid, journey_timeline, status_updated_at, created_at, consultation_payment_type, insurance_provider, insurance_policy_number')
      .eq('facility_id', facilityId)
      .in('patient_id', patientIds)
      .order('created_at', { ascending: false })
      .limit(100);

    if (visitsError) throw visitsError;

    const latestVisits = patients.map((patient) => {
      const patientVisits = visits?.filter((v) => v.patient_id === patient.id) || [];
      const latestVisit = patientVisits[0];

      return {
        id: latestVisit?.id || `patient-${patient.id}`,
        patient_id: patient.id,
        visit_date: latestVisit?.visit_date || new Date().toISOString().split('T')[0],
        reason: latestVisit?.reason || 'No visits yet',
        provider: latestVisit?.provider || '',
        fee_paid: latestVisit?.fee_paid || 0,
        created_at: latestVisit?.created_at || new Date().toISOString(),
        status: latestVisit?.status,
        journey_timeline: latestVisit?.journey_timeline || null,
        consultation_payment_type: latestVisit?.consultation_payment_type || null,
        insurance_provider: latestVisit?.insurance_provider || null,
        insurance_policy_number: latestVisit?.insurance_policy_number || null,
        patients: {
          id: patient.id,
          full_name: patient.full_name,
          phone: patient.phone || '',
          age: patient.age,
          gender: patient.gender,
        },
      };
    });

    if (tenantId) {
      await recordAuditEvent({
        action: 'search_patients',
        eventType: 'read',
        entityType: 'patient',
        tenantId,
        facilityId: facilityId || null,
        actorUserId: profileId || null,
        actorRole: role || null,
        actorIpAddress: req.ip,
        actorUserAgent: req.get('user-agent') || null,
        complianceTags: ['hipaa'],
        sensitivityLevel: 'phi',
        requestId: req.requestId || null,
        metadata: { result_count: latestVisits.length },
      });
    }

    return res.json({ visits: latestVisits });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to search patients' });
  }
});

router.post('/visits/:id/status', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = statusUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('visits')
      .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('facility_id', facilityId);

    if (error) throw error;
    if (tenantId) {
      await recordAuditEvent({
        action: 'update_visit_status',
        eventType: 'update',
        entityType: 'visit',
        entityId: req.params.id,
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
    return res.status(500).json({ error: error.message || 'Failed to update status' });
  }
});

router.post('/visits/:id/fee', async (req, res) => {
  const { facilityId, tenantId, profileId, role } = req.user!;
  const parsed = feeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('visits')
      .update({ fee_paid: parsed.data.feePaid, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('facility_id', facilityId);

    if (error) throw error;
    if (tenantId) {
      await recordAuditEvent({
        action: 'update_visit_fee',
        eventType: 'update',
        entityType: 'visit',
        entityId: req.params.id,
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
    return res.status(500).json({ error: error.message || 'Failed to update fee' });
  }
});

router.post('/appointments/:id/status', async (req, res) => {
  const { tenantId, facilityId, profileId, role } = req.user!;
  const parsed = appointmentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('appointments')
      .update({ status: parsed.data.status })
      .eq('id', req.params.id);

    if (error) throw error;
    if (tenantId) {
      await recordAuditEvent({
        action: 'update_appointment_status',
        eventType: 'update',
        entityType: 'appointment',
        entityId: req.params.id,
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
    return res.status(500).json({ error: error.message || 'Failed to update appointment' });
  }
});

export default router;
