const STRUCTURED_TAG_PREFIX = '[link_hew_structured:';
const STRUCTURED_TAG_SUFFIX = ']';
const MAX_NOTE_LENGTH = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeString = (value: unknown, maxLength = 512) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
};

const normalizeBooleanRecord = (value: unknown) => {
  if (!isRecord(value)) return {};
  const output: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key) continue;
    output[key] = raw === true;
  }
  return output;
};

const normalizeGuidedAnswers = (value: unknown) => {
  if (!isRecord(value)) return {};
  const output: Record<string, boolean | string | number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key) continue;
    if (typeof raw === 'boolean' || typeof raw === 'number') {
      output[key] = raw;
      continue;
    }
    if (typeof raw === 'string') {
      output[key] = raw.slice(0, 120);
    }
  }
  return output;
};

const normalizeReferralSummary = (value: unknown) => {
  if (!isRecord(value)) return null;
  return {
    protocol_id: normalizeString(value.protocol_id, 80),
    protocol_title: normalizeString(value.protocol_title, 160),
    urgency: normalizeString(value.urgency, 40),
    reason: normalizeString(value.reason, 500),
    recommendation: normalizeString(value.recommendation, 500),
    summary: normalizeString(value.summary, 800),
  };
};

const normalizeAgentGuidance = (value: unknown) => {
  if (!isRecord(value)) return null;
  const dangerSigns = Array.isArray(value.dangerSigns)
    ? value.dangerSigns.map((item) => normalizeString(item, 140)).filter(Boolean)
    : [];
  const nextSteps = Array.isArray(value.nextSteps)
    ? value.nextSteps.map((item) => normalizeString(item, 220)).filter(Boolean)
    : [];

  return {
    source: normalizeString(value.source, 64),
    status: normalizeString(value.status, 64),
    urgency: normalizeString(value.urgency, 40),
    escalationPrompt: normalizeString(value.escalationPrompt, 600),
    referralRecommendation: normalizeString(value.referralRecommendation, 600),
    dangerSigns,
    nextSteps,
  };
};

type BuildStructuredPayloadArgs = {
  guidedProtocol?: unknown;
  guidedAnswers?: unknown;
  dangerSigns?: unknown;
  referralSummary?: unknown;
  agentGuidance?: unknown;
};

export const buildHewStructuredPayload = ({
  guidedProtocol,
  guidedAnswers,
  dangerSigns,
  referralSummary,
  agentGuidance,
}: BuildStructuredPayloadArgs) => {
  const normalizedProtocol = isRecord(guidedProtocol)
    ? {
        id: normalizeString(guidedProtocol.id, 80),
        title: normalizeString(guidedProtocol.title, 160),
      }
    : null;

  const payload = {
    guidedProtocol: normalizedProtocol?.id ? normalizedProtocol : null,
    guidedAnswers: normalizeGuidedAnswers(guidedAnswers),
    dangerSigns: normalizeBooleanRecord(dangerSigns),
    referralSummary: normalizeReferralSummary(referralSummary),
    agentGuidance: normalizeAgentGuidance(agentGuidance),
  };

  const hasPayload =
    Boolean(payload.guidedProtocol) ||
    Object.keys(payload.guidedAnswers).length > 0 ||
    Object.keys(payload.dangerSigns).length > 0 ||
    Boolean(payload.referralSummary) ||
    Boolean(payload.agentGuidance);

  return hasPayload ? payload : null;
};

const encodeStructuredPayload = (payload: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const decodeStructuredPayload = (encoded: string) => {
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const attachStructuredPayloadToNoteText = (
  noteText: string,
  payload: Record<string, unknown> | null
) => {
  const base = String(noteText || '').trim();
  if (!payload) return base;

  const encoded = encodeStructuredPayload(payload);
  const marker = `${STRUCTURED_TAG_PREFIX}${encoded}${STRUCTURED_TAG_SUFFIX}`;
  const separator = base.length > 0 ? '\n\n' : '';
  const combined = `${base}${separator}${marker}`;

  if (combined.length <= MAX_NOTE_LENGTH) {
    return combined;
  }

  const reservedLength = marker.length + separator.length;
  const allowedBaseLength = Math.max(0, MAX_NOTE_LENGTH - reservedLength);
  const trimmedBase = base.slice(0, allowedBaseLength).trimEnd();
  return `${trimmedBase}${separator}${marker}`.slice(0, MAX_NOTE_LENGTH);
};

export const parseStructuredPayloadFromNoteText = (rawNoteText: unknown) => {
  const text = String(rawNoteText || '');
  const start = text.lastIndexOf(STRUCTURED_TAG_PREFIX);
  if (start === -1) {
    return { noteText: text, structuredPayload: null as Record<string, unknown> | null };
  }

  const end = text.indexOf(STRUCTURED_TAG_SUFFIX, start + STRUCTURED_TAG_PREFIX.length);
  if (end === -1) {
    return { noteText: text, structuredPayload: null as Record<string, unknown> | null };
  }

  const encoded = text.slice(start + STRUCTURED_TAG_PREFIX.length, end);
  const parsed = decodeStructuredPayload(encoded);
  if (!parsed) {
    return { noteText: text, structuredPayload: null as Record<string, unknown> | null };
  }

  const cleanText = `${text.slice(0, start).trimEnd()}${text.slice(end + STRUCTURED_TAG_SUFFIX.length)}`.trim();
  return {
    noteText: cleanText,
    structuredPayload: parsed,
  };
};

export const extractStructuredNoteFields = (rawNoteText: unknown) => {
  const { noteText, structuredPayload } = parseStructuredPayloadFromNoteText(rawNoteText);
  const payload = structuredPayload || {};

  const guidedProtocol = isRecord(payload.guidedProtocol) ? payload.guidedProtocol : null;
  const guidedAnswers = isRecord(payload.guidedAnswers) ? payload.guidedAnswers : {};
  const dangerSigns = isRecord(payload.dangerSigns) ? payload.dangerSigns : {};
  const referralSummary = isRecord(payload.referralSummary) ? payload.referralSummary : null;
  const agentGuidance = isRecord(payload.agentGuidance) ? payload.agentGuidance : null;

  return {
    noteText,
    guidedProtocol,
    guidedAnswers,
    dangerSigns,
    referralSummary,
    agentGuidance,
  };
};
