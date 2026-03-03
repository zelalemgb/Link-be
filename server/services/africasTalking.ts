/**
 * Africa's Talking SMS service
 *
 * Handles:
 *  - Inbound webhook signature validation (HMAC-SHA256)
 *  - Outbound SMS via the AT Messaging API
 *  - Simple Amharic/English symptom keyword extraction
 *  - Urgency classification from symptom keywords
 */

import crypto from 'crypto';

// ─── Config ───────────────────────────────────────────────────────────────────

const AT_API_KEY  = process.env.AT_API_KEY ?? '';
const AT_USERNAME = process.env.AT_USERNAME ?? 'sandbox';
const AT_SENDER   = process.env.AT_SENDER_ID ?? 'LINK';          // Registered short-code or alphanumeric
const AT_BASE_URL = 'https://api.africastalking.com/version1/messaging';

// ─── Signature validation ─────────────────────────────────────────────────────

/**
 * Verify the X-AT-SIGNATURE header that Africa's Talking attaches to
 * every inbound webhook POST.
 *
 * AT signs: HMAC-SHA256(rawBody, AT_API_KEY)
 * and hex-encodes the result.
 */
export function verifyAtSignature(rawBody: Buffer, signature: string): boolean {
  if (!AT_API_KEY) return true; // Dev / test: skip if no key configured
  const expected = crypto
    .createHmac('sha256', AT_API_KEY)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Symptom keyword extraction ───────────────────────────────────────────────

/** Very lightweight keyword tables — extend from actual clinical guidelines */
const SYMPTOM_KEYWORDS_EN: Record<string, string[]> = {
  fever:         ['fever', 'hot', 'temperature', 'chills'],
  headache:      ['headache', 'head pain', 'migraine'],
  vomiting:      ['vomit', 'nausea', 'throwing up', 'sick'],
  diarrhea:      ['diarrhea', 'diarrhoea', 'loose stool', 'watery stool'],
  cough:         ['cough', 'coughing', 'chest pain'],
  breathlessness:['breathless', 'difficulty breathing', 'shortness of breath', 'dyspnea'],
  bleeding:      ['bleed', 'blood', 'hemorrhage'],
  pregnancy:     ['pregnant', 'pregnancy', 'labor', 'delivery', 'antenatal', 'anc'],
  child_sick:    ['baby', 'infant', 'child', 'my son', 'my daughter'],
  malaria:       ['malaria', 'shivers', 'shaking'],
  convulsion:    ['convuls', 'seizure', 'fit', 'shaking'],
};

const SYMPTOM_KEYWORDS_AM: Record<string, string[]> = {
  fever:         ['ሙቀት', 'ትኩሳት'],
  headache:      ['ራስ ምታት'],
  vomiting:      ['ማቅለሸለሽ', 'ትውኪት'],
  diarrhea:      ['ተቅማጥ'],
  breathlessness:['ትንፋሽ'],
  pregnancy:     ['እርግዝና', 'ወሊድ', 'ነፍሰ ጡር'],
  convulsion:    ['ሲጥ'],
};

export function extractSymptoms(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();

  for (const [key, terms] of Object.entries(SYMPTOM_KEYWORDS_EN)) {
    if (terms.some((t) => lower.includes(t))) found.add(key);
  }
  for (const [key, terms] of Object.entries(SYMPTOM_KEYWORDS_AM)) {
    if (terms.some((t) => text.includes(t))) found.add(key);
  }

  return [...found];
}

// ─── Language detection ───────────────────────────────────────────────────────

/** Heuristic: if message contains Ethiopic characters → Amharic */
export function detectLanguage(text: string): 'am' | 'en' {
  return /[\u1200-\u137F]/.test(text) ? 'am' : 'en';
}

// ─── Urgency classification ────────────────────────────────────────────────────

type Urgency = 'emergency' | 'urgent' | 'routine' | 'unknown';
type Cohort  = 'adult' | 'pediatric' | 'maternal';

const EMERGENCY_SYMPTOMS  = new Set(['convulsion', 'bleeding', 'breathlessness']);
const URGENT_SYMPTOMS     = new Set(['fever', 'vomiting', 'malaria']);
const MATERNAL_SYMPTOMS   = new Set(['pregnancy']);
const PEDIATRIC_SYMPTOMS  = new Set(['child_sick']);

export function classifyUrgency(symptoms: string[]): { urgency: Urgency; cohort: Cohort } {
  const set = new Set(symptoms);

  let urgency: Urgency = symptoms.length === 0 ? 'unknown' : 'routine';
  if ([...URGENT_SYMPTOMS].some((s) => set.has(s)))    urgency = 'urgent';
  if ([...EMERGENCY_SYMPTOMS].some((s) => set.has(s))) urgency = 'emergency';

  let cohort: Cohort = 'adult';
  if ([...MATERNAL_SYMPTOMS].some((s) => set.has(s)))  cohort = 'maternal';
  if ([...PEDIATRIC_SYMPTOMS].some((s) => set.has(s))) cohort = 'pediatric';

  return { urgency, cohort };
}

// ─── AI summary ───────────────────────────────────────────────────────────────

export function buildAiSummary(symptoms: string[], urgency: Urgency, lang: 'am' | 'en'): string {
  if (symptoms.length === 0) return 'Patient reported symptoms via SMS — details unclear.';
  const list = symptoms.map((s) => s.replace(/_/g, ' ')).join(', ');
  return `SMS pre-triage: ${urgency} — reported ${list}.`;
}

// ─── Reply messages ───────────────────────────────────────────────────────────

export function buildReplyMessage(urgency: Urgency, lang: 'am' | 'en'): string {
  if (lang === 'am') {
    const map: Record<Urgency, string> = {
      emergency: 'ድንገተኛ ሁኔታ ይመስላል። ወደ ጤና ተቋሙ ወዲያው ይምጡ ወይም 907 ይደውሉ።',
      urgent:    'ምልክቶችዎ ፈጣን ትኩረት ያስፈልጋቸዋል። ዛሬ ወደ ጤና ጣቢያ ይምጡ።',
      routine:   'ምሳሌ ጤናዎ ለሐኪም ሊገለጽ ይችላል። ወደ ቀጠሮ ይምጡ።',
      unknown:   'መልዕክቱ ደርሷል። ወደ ጤና ጣቢያ ይምጡ ወይም ሐኪምዎን ያናግሩ።',
    };
    return map[urgency];
  }
  const map: Record<Urgency, string> = {
    emergency: 'This looks like an EMERGENCY. Please come to the facility immediately or call 907.',
    urgent:    'Your symptoms need prompt attention. Please visit the clinic today.',
    routine:   'Your concern has been noted. Please come for a scheduled visit.',
    unknown:   'Thank you for reaching out. Please visit the nearest health facility.',
  };
  return map[urgency];
}

// ─── Outbound SMS ─────────────────────────────────────────────────────────────

export interface SendSmsOptions {
  to: string;          // E.164 phone number
  message: string;
}

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendSms({ to, message }: SendSmsOptions): Promise<SendSmsResult> {
  if (!AT_API_KEY) {
    console.warn('[AT] No API key configured — SMS not sent (dev mode)');
    return { success: true, messageId: 'dev-skip' };
  }

  const params = new URLSearchParams({
    username: AT_USERNAME,
    to,
    message,
    ...(AT_SENDER ? { from: AT_SENDER } : {}),
  });

  const res = await fetch(AT_BASE_URL, {
    method: 'POST',
    headers: {
      apiKey: AT_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[AT] Send SMS failed', res.status, text);
    return { success: false, error: `AT API error ${res.status}` };
  }

  const json = (await res.json()) as any;
  const recipient = json?.SMSMessageData?.Recipients?.[0];
  const messageId = recipient?.messageId ?? undefined;
  const status    = recipient?.status ?? 'unknown';

  if (status !== 'Success') {
    return { success: false, error: `AT delivery status: ${status}` };
  }

  return { success: true, messageId };
}
