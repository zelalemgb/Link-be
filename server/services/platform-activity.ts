import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase';

type PlatformActivityCategory =
  | 'session'
  | 'navigation'
  | 'auth'
  | 'registration'
  | 'action'
  | 'api'
  | 'error';

type PlatformActivityOutcome = 'started' | 'success' | 'failure' | 'info';

export type PlatformActivityEvent = {
  sessionId?: string | null;
  source?: string | null;
  category: PlatformActivityCategory;
  eventName: string;
  outcome?: PlatformActivityOutcome | null;
  actorUserId?: string | null;
  actorAuthUserId?: string | null;
  actorRole?: string | null;
  actorEmail?: string | null;
  tenantId?: string | null;
  facilityId?: string | null;
  pagePath?: string | null;
  pageTitle?: string | null;
  entryPoint?: string | null;
  requestPath?: string | null;
  requestMethod?: string | null;
  responseStatus?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
  referrer?: string | null;
  timezone?: string | null;
  locale?: string | null;
  occurredAt?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type PlatformActivityContext = {
  actorUserId?: string | null;
  actorAuthUserId?: string | null;
  actorRole?: string | null;
  actorEmail?: string | null;
  tenantId?: string | null;
  facilityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asUuidOrNull = (value?: string | null) => {
  if (!value) return null;
  const normalized = value.trim();
  return uuidPattern.test(normalized) ? normalized : null;
};

const clampText = (value: unknown, max = 512) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, max);
};

const clampInt = (value: unknown, max = 24 * 60 * 60 * 1000) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  return Math.min(Math.round(value), max);
};

const asIsoTimestampOrNow = (value?: string | null) => {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
};

const sanitizeMetadata = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
};

const mergeMetadata = (
  event: PlatformActivityEvent,
  context: PlatformActivityContext
) => {
  const metadata = sanitizeMetadata(event.metadata);
  return {
    ...metadata,
    actor_role_hint: clampText(event.actorRole, 128),
    actor_email_hint: clampText(event.actorEmail, 320),
    request_path: clampText(event.requestPath, 512),
    request_method: clampText(event.requestMethod, 16),
    response_status: typeof event.responseStatus === 'number' ? event.responseStatus : null,
    duration_ms: clampInt(event.durationMs),
    page_path: clampText(event.pagePath, 512),
    entry_point: clampText(event.entryPoint, 160),
    referrer: clampText(event.referrer, 512),
    timezone: clampText(event.timezone, 120),
    locale: clampText(event.locale, 64),
    source: clampText(event.source, 32) || 'web',
    actor_email: clampText(context.actorEmail || event.actorEmail, 320),
  };
};

export const recordPlatformActivityEvents = async (
  events: PlatformActivityEvent[],
  context: PlatformActivityContext = {}
) => {
  if (process.env.PLATFORM_ACTIVITY_ENABLED === 'false' || events.length === 0) {
    return { inserted: 0 };
  }

  const rows = events.map((event) => ({
    session_id: asUuidOrNull(event.sessionId) || randomUUID(),
    source: clampText(event.source, 32) || 'web',
    category: event.category,
    event_name: clampText(event.eventName, 160) || 'platform.activity',
    outcome: clampText(event.outcome, 32),
    actor_user_id: asUuidOrNull(context.actorUserId) || asUuidOrNull(event.actorUserId),
    actor_auth_user_id: asUuidOrNull(context.actorAuthUserId) || asUuidOrNull(event.actorAuthUserId),
    actor_role: clampText(context.actorRole || event.actorRole, 128),
    actor_email: clampText(context.actorEmail || event.actorEmail, 320),
    tenant_id: asUuidOrNull(context.tenantId) || asUuidOrNull(event.tenantId),
    facility_id: asUuidOrNull(context.facilityId) || asUuidOrNull(event.facilityId),
    page_path: clampText(event.pagePath, 512),
    page_title: clampText(event.pageTitle, 320),
    entry_point: clampText(event.entryPoint, 160),
    request_path: clampText(event.requestPath, 512),
    request_method: clampText(event.requestMethod, 16),
    response_status:
      typeof event.responseStatus === 'number' && Number.isFinite(event.responseStatus)
        ? Math.round(event.responseStatus)
        : null,
    duration_ms: clampInt(event.durationMs),
    error_message: clampText(event.errorMessage, 1200),
    ip_address: clampText(context.ipAddress, 64),
    user_agent: clampText(context.userAgent, 1024),
    referrer: clampText(event.referrer, 512),
    timezone: clampText(event.timezone, 120),
    locale: clampText(event.locale, 64),
    metadata: mergeMetadata(event, context),
    occurred_at: asIsoTimestampOrNow(event.occurredAt),
  }));

  const { error } = await supabaseAdmin.from('platform_activity_log').insert(rows);
  if (error) {
    throw new Error(error.message || 'Failed to write platform activity');
  }

  return { inserted: rows.length };
};

export const recordPlatformActivityEvent = async (
  event: PlatformActivityEvent,
  context: PlatformActivityContext = {}
) => recordPlatformActivityEvents([event], context);
