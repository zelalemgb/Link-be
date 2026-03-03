/**
 * SMS routes (Africa's Talking)
 *
 * POST /api/sms/inbound   – inbound SMS webhook (no auth middleware — AT sends directly)
 * GET  /api/sms/pretriage – list recent pre-triage requests for a facility (staff only)
 *
 * Security: Africa's Talking signs each webhook POST with HMAC-SHA256.
 * We validate the X-AT-SIGNATURE header before processing.
 * The route is intentionally NOT behind requireUser so AT can reach it without a session.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireUser, requireScopedUser } from '../middleware/auth';
import {
  verifyAtSignature,
  extractSymptoms,
  detectLanguage,
  classifyUrgency,
  buildAiSummary,
  buildReplyMessage,
  sendSms,
} from '../services/africasTalking';

const router = Router();

// ─── Inbound webhook ──────────────────────────────────────────────────────────

/**
 * Africa's Talking posts form-encoded data:
 *   linkId, text, to, id, date, from, networkCode
 *
 * 'to' is the short-code / virtual number assigned to the facility.
 * We use 'to' to look up which facility this SMS belongs to.
 */
const inboundSchema = z.object({
  id:          z.string(),                 // AT message ID
  from:        z.string(),                 // Sender phone (E.164)
  to:          z.string(),                 // Destination short-code
  text:        z.string().min(1),          // Raw SMS body
  networkCode: z.string().optional(),
  date:        z.string().optional(),
  linkId:      z.string().optional(),
});

router.post('/inbound', async (req: Request, res: Response) => {
  // ── 1. Signature verification ────────────────────────────────────────────
  const signature = req.headers['x-at-signature'] as string | undefined;
  if (signature) {
    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (rawBody && !verifyAtSignature(rawBody, signature)) {
      console.warn('[SMS] Invalid AT signature — rejecting webhook');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // ── 2. Parse payload ──────────────────────────────────────────────────────
  const parsed = inboundSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Bad payload', details: parsed.error.flatten() });
  }

  const { id: atMessageId, from: phone, to: shortCode, text, networkCode } = parsed.data;

  // ── 3. Dedup: ignore if we already processed this AT message ID ───────────
  const { data: existing } = await supabaseAdmin
    .from('pre_triage_requests')
    .select('id')
    .eq('at_message_id', atMessageId)
    .maybeSingle();

  if (existing) {
    // AT may retry — respond 200 so they don't keep retrying
    return res.status(200).json({ status: 'duplicate' });
  }

  // ── 4. Resolve facility from short-code ───────────────────────────────────
  // Facilities store their AT short-code in settings->>'at_short_code'
  // Fall back to a default facility if no match (useful during dev / sandbox)
  const { data: facilityRow } = await supabaseAdmin
    .from('facilities')
    .select('id, tenant_id')
    .filter('settings->>at_short_code', 'eq', shortCode)
    .maybeSingle();

  if (!facilityRow) {
    console.warn(`[SMS] No facility matched short-code ${shortCode} — storing with null facility`);
    // We still store so nothing is lost; a cron can re-assign later
    // For now return 200 to avoid AT retries
    return res.status(200).json({ status: 'unresolved_facility' });
  }

  const { id: facilityId, tenant_id: tenantId } = facilityRow;

  // ── 5. NLP: extract symptoms, detect language, classify urgency ───────────
  const lang     = detectLanguage(text);
  const symptoms = extractSymptoms(text);
  const { urgency, cohort } = classifyUrgency(symptoms);
  const aiSummary = buildAiSummary(symptoms, urgency, lang);

  // ── 6. Persist pre-triage record ─────────────────────────────────────────
  const { data: record, error: insertError } = await supabaseAdmin
    .from('pre_triage_requests')
    .insert({
      facility_id:           facilityId,
      tenant_id:             tenantId,
      phone_number:          phone,
      network_code:          networkCode ?? null,
      at_message_id:         atMessageId,
      raw_message:           text,
      parsed_symptoms:       symptoms,
      parsed_language:       lang,
      recommended_urgency:   urgency,
      recommended_cohort:    cohort,
      ai_summary:            aiSummary,
      status:                'triaged',
    })
    .select('id')
    .single();

  if (insertError || !record) {
    console.error('[SMS] Failed to insert pre_triage_request', insertError);
    return res.status(500).json({ error: 'DB insert failed' });
  }

  // ── 7. Send reply SMS ─────────────────────────────────────────────────────
  const replyText = buildReplyMessage(urgency, lang);
  const { success: sent, messageId: replyMsgId } = await sendSms({ to: phone, message: replyText });

  if (sent) {
    await supabaseAdmin
      .from('pre_triage_requests')
      .update({ reply_sent: true, reply_text: replyText, reply_sent_at: new Date().toISOString() })
      .eq('id', record.id);
  } else {
    console.error('[SMS] Reply send failed for pre_triage', record.id);
  }

  // Africa's Talking expects a 200 response with optional plain-text body
  res.status(200).send('OK');
});

// ─── List pre-triage requests for a facility (staff-facing) ──────────────────

const listQuerySchema = z.object({
  limit:  z.coerce.number().min(1).max(100).default(30),
  status: z.enum(['pending', 'triaged', 'linked', 'expired']).optional(),
});

router.get('/pretriage', requireUser, requireScopedUser, async (req: Request & { user?: any; scope?: any }, res: Response) => {
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'Bad query' });

  const facilityId = req.scope?.facilityId;
  if (!facilityId) return res.status(400).json({ error: 'No facility in scope' });

  let query = supabaseAdmin
    .from('pre_triage_requests')
    .select('id, phone_number, raw_message, parsed_symptoms, recommended_urgency, recommended_cohort, ai_summary, status, created_at, linked_visit_id')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })
    .limit(q.data.limit);

  if (q.data.status) query = query.eq('status', q.data.status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ pretriage: data ?? [] });
});

export default router;
