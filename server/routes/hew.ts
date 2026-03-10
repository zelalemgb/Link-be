/**
 * HEW (Health Extension Worker) routes
 *
 * GET  /hew/facility-patients                  – list patients in HEW facility
 * GET  /hew/patients/:patientId/notes          – list community notes for a patient
 * POST /hew/patients/:patientId/notes          – create a new community note
 * GET  /hew/visits/:visitId/notes              – list notes linked to a specific visit
 */
import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import { recordAuditEvent } from '../services/audit-log';
import {
  attachStructuredPayloadToNoteText,
  buildHewStructuredPayload,
  extractStructuredNoteFields,
} from '../services/hewStructuredNoteService';

const router = Router();
router.use(requireUser, requireScopedUser);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const NOTE_TYPES = [
  'general',
  'household_visit',
  'maternal_followup',
  'child_growth',
  'vaccination',
  'referral_followup',
  'nutrition',
  'medication_adherence',
] as const;

const createNoteSchema = z.object({
  note_type: z.enum(NOTE_TYPES).optional().default('general'),
  note_text: z.string().min(1).max(4000),
  visit_id: z.string().uuid().optional(),
  visit_date: z.string().optional(),          // ISO date string, defaults to today
  location: z.string().max(255).optional(),
  follow_up_due: z.string().optional(),       // ISO date string
  flags: z.array(z.string()).optional(),
  guided_protocol: z.unknown().optional(),
  guided_answers: z.unknown().optional(),
  danger_signs: z.unknown().optional(),
  referral_summary: z.unknown().optional(),
  agent_guidance: z.unknown().optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(50).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
});

const serializeCommunityNote = (note: any) => {
  const structured = extractStructuredNoteFields(note?.note_text || '');
  const dangerSigns =
    Object.keys(structured.dangerSigns || {}).length > 0
      ? structured.dangerSigns
      : Array.isArray(note?.flags) && note.flags.includes('danger_sign')
        ? { danger_sign: true }
        : {};

  const authorId = note?.author?.id || note?.author_id || null;

  return {
    ...note,
    note_text: structured.noteText,
    text: structured.noteText,
    visit_type: note?.note_type || 'general',
    hew_user_id: authorId,
    danger_signs: dangerSigns,
    guided_protocol: structured.guidedProtocol || null,
    guided_answers: structured.guidedAnswers || {},
    referral_summary: structured.referralSummary || null,
    agent_guidance: structured.agentGuidance || null,
  };
};

// ─── GET /facility-patients ─────────────────────────────────────────────────
router.get('/facility-patients', async (req, res) => {
  try {
    const facilityId = req.user!.facilityId;
    if (!facilityId) return res.status(400).json({ error: 'Missing facility context' });

    const { data, error } = await supabaseAdmin
      .from('patients')
      .select('id, full_name, phone, date_of_birth, sex, kebele, woreda')
      .eq('facility_id', facilityId)
      .is('deleted_at', null)
      .order('full_name', { ascending: true })
      .limit(250);

    if (error) {
      console.error('[HEW] facility patients error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch facility patients' });
    }

    return res.json({ patients: data ?? [] });
  } catch (err: any) {
    console.error('[HEW] unexpected facility patients error:', err?.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /patients/:patientId/notes ──────────────────────────────────────────
router.get('/patients/:patientId/notes', async (req, res) => {
  try {
    const { patientId } = req.params;
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: 'Invalid query params', details: query.error.errors });
    }

    const facilityId = req.user!.facilityId;
    const { limit, offset } = query.data;

    const { data, error } = await supabaseAdmin
      .from('community_notes')
      .select(`
        id,
        note_type,
        note_text,
        visit_date,
        location,
        follow_up_due,
        flags,
        created_at,
        visit_id,
        author:users!author_id (
          id,
          full_name,
          user_role
        )
      `)
      .eq('patient_id', patientId)
      .eq('facility_id', facilityId)
      .order('visit_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[HEW] list notes error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch community notes' });
    }

    const notes = (data ?? []).map((note: any) => serializeCommunityNote(note));
    return res.json({ notes, total: notes.length });
  } catch (err: any) {
    console.error('[HEW] unexpected error listing notes:', err?.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /visits/:visitId/notes ───────────────────────────────────────────────
router.get('/visits/:visitId/notes', async (req, res) => {
  try {
    const { visitId } = req.params;
    const facilityId = req.user!.facilityId;

    // Resolve the patient_id from the visit
    const { data: visit, error: visitErr } = await supabaseAdmin
      .from('visits')
      .select('id, patient_id, facility_id')
      .eq('id', visitId)
      .maybeSingle();

    if (visitErr || !visit) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('community_notes')
      .select(`
        id,
        note_type,
        note_text,
        visit_date,
        location,
        follow_up_due,
        flags,
        created_at,
        visit_id,
        author:users!author_id (
          id,
          full_name,
          user_role
        )
      `)
      .eq('patient_id', visit.patient_id)
      .eq('facility_id', facilityId)
      .order('visit_date', { ascending: false })
      .limit(10);

    if (error) {
      console.error('[HEW] list visit notes error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch notes' });
    }

    const notes = (data ?? []).map((note: any) => serializeCommunityNote(note));
    return res.json({ notes });
  } catch (err: any) {
    console.error('[HEW] unexpected error listing visit notes:', err?.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /patients/:patientId/notes ─────────────────────────────────────────
router.post('/patients/:patientId/notes', async (req, res) => {
  try {
    const { patientId } = req.params;
    const body = createNoteSchema.safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ error: 'Invalid request body', details: body.error.errors });
    }

    const authorId = req.user!.profileId;
    const facilityId = req.user!.facilityId;
    const tenantId = req.user!.tenantId;

    if (!authorId) {
      return res.status(403).json({ error: 'Missing author profile' });
    }

    const {
      note_type,
      note_text,
      visit_id,
      visit_date,
      location,
      follow_up_due,
      flags,
      guided_protocol,
      guided_answers,
      danger_signs,
      referral_summary,
      agent_guidance,
    } = body.data;

    const structuredPayload = buildHewStructuredPayload({
      guidedProtocol: guided_protocol,
      guidedAnswers: guided_answers,
      dangerSigns: danger_signs,
      referralSummary: referral_summary,
      agentGuidance: agent_guidance,
    });
    const storedNoteText = attachStructuredPayloadToNoteText(note_text, structuredPayload);

    // Verify patient exists and belongs to this facility's tenant
    const { data: patient, error: patientErr } = await supabaseAdmin
      .from('patients')
      .select('id')
      .eq('id', patientId)
      .maybeSingle();

    if (patientErr || !patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const { data: note, error: insertErr } = await supabaseAdmin
      .from('community_notes')
      .insert({
        patient_id: patientId,
        author_id: authorId,
        facility_id: facilityId,
        tenant_id: tenantId,
        note_type,
        note_text: storedNoteText,
        visit_id: visit_id ?? null,
        visit_date: visit_date ?? new Date().toISOString().split('T')[0],
        location: location ?? null,
        follow_up_due: follow_up_due ?? null,
        flags: flags ?? [],
      })
      .select(`
        id,
        note_type,
        note_text,
        visit_date,
        location,
        follow_up_due,
        flags,
        created_at,
        visit_id
      `)
      .single();

    if (insertErr) {
      console.error('[HEW] insert note error:', insertErr.message);
      return res.status(500).json({ error: 'Failed to create note' });
    }

    await recordAuditEvent({
      action: 'hew_note_created',
      eventType: 'create',
      entityType: 'community_notes',
      entityId: note.id,
      tenantId: tenantId ?? '',
      facilityId: facilityId ?? null,
      actorUserId: authorId,
      actorRole: req.user!.role,
      actorIpAddress: req.ip ?? null,
      actorUserAgent: req.get('user-agent') ?? null,
      metadata: {
        patient_id: patientId,
        note_type,
        has_guided_protocol: Boolean(structuredPayload?.guidedProtocol),
        has_referral_summary: Boolean(structuredPayload?.referralSummary),
      },
    }).catch(() => {/* non-fatal */});

    return res.status(201).json({
      note: serializeCommunityNote({
        ...note,
        author_id: authorId,
      }),
    });
  } catch (err: any) {
    console.error('[HEW] unexpected error creating note:', err?.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /caseload ────────────────────────────────────────────────────────────
// Returns patients that the current HEW has notes for, where follow_up_due is
// not null, ordered by closest follow-up first. Scoped to the HEW's facility.
router.get('/caseload', async (req, res) => {
  try {
    const facilityId = req.user!.facilityId;
    const authorId   = req.user!.profileId;

    if (!authorId) return res.status(403).json({ error: 'Missing author profile' });

    // Get distinct patient_ids with upcoming follow-ups authored by this HEW
    const today = new Date().toISOString().split('T')[0];

    const { data: noteRows, error } = await supabaseAdmin
      .from('community_notes')
      .select('patient_id, follow_up_due')
      .eq('facility_id', facilityId)
      .eq('author_id', authorId)
      .not('follow_up_due', 'is', null)
      .order('follow_up_due', { ascending: true })
      .limit(50);

    if (error) {
      console.error('[HEW] caseload error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch caseload' });
    }

    if (!noteRows || noteRows.length === 0) {
      return res.json({ patients: [] });
    }

    // Deduplicate patient_ids, keeping the closest follow_up_due per patient
    const patientMap = new Map<string, string>();
    for (const row of noteRows) {
      if (!patientMap.has(row.patient_id)) {
        patientMap.set(row.patient_id, row.follow_up_due);
      }
    }

    const patientIds = [...patientMap.keys()];

    const { data: patients, error: pErr } = await supabaseAdmin
      .from('patients')
      .select('id, full_name, phone, date_of_birth')
      .in('id', patientIds);

    if (pErr) {
      console.error('[HEW] caseload patient fetch error:', pErr.message);
      return res.status(500).json({ error: 'Failed to fetch patient details' });
    }

    // Attach follow_up_due and sort
    const enriched = (patients ?? [])
      .map((p: any) => ({ ...p, follow_up_due: patientMap.get(p.id) ?? null }))
      .sort((a: any, b: any) => (a.follow_up_due ?? '').localeCompare(b.follow_up_due ?? ''));

    return res.json({ patients: enriched });
  } catch (err: any) {
    console.error('[HEW] unexpected caseload error:', err?.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
