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
  frontendReleaseSha?: string | null;
  frontendAssetBundle?: string | null;
  serviceWorkerState?: string | null;
  serviceWorkerScriptUrl?: string | null;
  networkOnline?: boolean | null;
  networkEffectiveType?: string | null;
  authBootstrapPhase?: string | null;
  scopeSource?: string | null;
  requestId?: string | null;
  errorFingerprint?: string | null;
  failureKind?: string | null;
  serverDecisionReason?: string | null;
  routeFrom?: string | null;
  activeFacilityId?: string | null;
  failingChunkUrl?: string | null;
  boundaryName?: string | null;
  componentStack?: string | null;
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

const clampBoolean = (value: unknown) => {
  if (typeof value !== 'boolean') return null;
  return value;
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

const resolveDeploymentEnvironment = () => {
  const nodeEnv = clampText(process.env.NODE_ENV, 32)?.toLowerCase();
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'test') return 'test';
  return 'local';
};

const resolveAppOriginHint = () =>
  clampText(
    process.env.FRONTEND_URL || process.env.APP_BASE_URL || process.env.BACKEND_URL || process.env.RAILWAY_STATIC_URL,
    512
  );

const resolveBackendReleaseSha = () =>
  clampText(
    process.env.RELEASE_SHA ||
      process.env.GIT_SHA ||
      process.env.COMMIT_SHA ||
      process.env.K_REVISION,
    128
  );

const deriveFailureKind = (event: PlatformActivityEvent) => {
  const explicit = clampText(event.failureKind, 64);
  if (explicit) return explicit;

  const errorMessage = String(event.errorMessage || '').toLowerCase();
  if (event.category === 'error') return 'client_crash';
  if (errorMessage.includes('chunk') || errorMessage.includes('dynamically imported module')) return 'chunk_load';
  if (errorMessage.includes('failed to fetch') || errorMessage.includes('network') || errorMessage.includes('internet_disconnected')) {
    return 'transport';
  }
  if (typeof event.responseStatus === 'number') return 'http_response';
  if (errorMessage.includes('auth') || errorMessage.includes('session')) return 'auth_bootstrap';
  return null;
};

const mergeMetadata = (
  event: PlatformActivityEvent,
  context: PlatformActivityContext
) => {
  const metadata = sanitizeMetadata(event.metadata);
  return {
    ...metadata,
    environment: clampText((metadata as Record<string, unknown>).environment, 32) || resolveDeploymentEnvironment(),
    app_origin: clampText((metadata as Record<string, unknown>).app_origin, 512) || resolveAppOriginHint(),
    frontend_release_sha:
      clampText(event.frontendReleaseSha, 128) ||
      clampText((metadata as Record<string, unknown>).frontend_release_sha, 128) ||
      clampText((metadata as Record<string, unknown>).release_sha, 128),
    backend_release_sha:
      clampText((metadata as Record<string, unknown>).backend_release_sha, 128) || resolveBackendReleaseSha(),
    frontend_asset_bundle:
      clampText(event.frontendAssetBundle, 320) || clampText((metadata as Record<string, unknown>).frontend_asset_bundle, 320),
    service_worker_state:
      clampText(event.serviceWorkerState, 64) || clampText((metadata as Record<string, unknown>).service_worker_state, 64),
    service_worker_script_url:
      clampText(event.serviceWorkerScriptUrl, 512) ||
      clampText((metadata as Record<string, unknown>).service_worker_script_url, 512),
    network_online:
      clampBoolean(event.networkOnline) ?? ((metadata as Record<string, unknown>).network_online as boolean | null | undefined) ?? null,
    network_effective_type:
      clampText(event.networkEffectiveType, 64) || clampText((metadata as Record<string, unknown>).network_effective_type, 64),
    auth_bootstrap_phase:
      clampText(event.authBootstrapPhase, 64) || clampText((metadata as Record<string, unknown>).auth_bootstrap_phase, 64),
    scope_source:
      clampText(event.scopeSource, 64) || clampText((metadata as Record<string, unknown>).scope_source, 64),
    request_id:
      asUuidOrNull(event.requestId) || asUuidOrNull((metadata as Record<string, unknown>).request_id as string | null | undefined),
    error_fingerprint:
      clampText(event.errorFingerprint, 256) || clampText((metadata as Record<string, unknown>).error_fingerprint, 256),
    failure_kind:
      deriveFailureKind(event) || clampText((metadata as Record<string, unknown>).failure_kind, 64),
    server_decision_reason:
      clampText(event.serverDecisionReason, 128) || clampText((metadata as Record<string, unknown>).server_decision_reason, 128),
    route_from:
      clampText(event.routeFrom, 512) || clampText((metadata as Record<string, unknown>).route_from, 512),
    active_facility_id:
      asUuidOrNull(event.activeFacilityId) ||
      asUuidOrNull((metadata as Record<string, unknown>).active_facility_id as string | null | undefined),
    failing_chunk_url:
      clampText(event.failingChunkUrl, 512) || clampText((metadata as Record<string, unknown>).failing_chunk_url, 512),
    boundary_name:
      clampText(event.boundaryName, 160) || clampText((metadata as Record<string, unknown>).boundary_name, 160),
    component_stack:
      clampText(event.componentStack, 4000) || clampText((metadata as Record<string, unknown>).component_stack, 4000),
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
    frontend_release_sha:
      clampText(event.frontendReleaseSha, 128) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.frontend_release_sha, 128) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.release_sha, 128),
    backend_release_sha: resolveBackendReleaseSha(),
    frontend_asset_bundle:
      clampText(event.frontendAssetBundle, 320) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.frontend_asset_bundle, 320),
    service_worker_state:
      clampText(event.serviceWorkerState, 64) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.service_worker_state, 64),
    service_worker_script_url:
      clampText(event.serviceWorkerScriptUrl, 512) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.service_worker_script_url, 512),
    network_online:
      clampBoolean(event.networkOnline) ??
      ((event.metadata as Record<string, unknown> | null | undefined)?.network_online as boolean | null | undefined) ??
      null,
    network_effective_type:
      clampText(event.networkEffectiveType, 64) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.network_effective_type, 64),
    auth_bootstrap_phase:
      clampText(event.authBootstrapPhase, 64) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.auth_bootstrap_phase, 64),
    scope_source:
      clampText(event.scopeSource, 64) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.scope_source, 64),
    request_id:
      asUuidOrNull(event.requestId) ||
      asUuidOrNull((event.metadata as Record<string, unknown> | null | undefined)?.request_id as string | null | undefined),
    error_fingerprint:
      clampText(event.errorFingerprint, 256) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.error_fingerprint, 256),
    failure_kind:
      deriveFailureKind(event) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.failure_kind, 64),
    server_decision_reason:
      clampText(event.serverDecisionReason, 128) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.server_decision_reason, 128),
    route_from:
      clampText(event.routeFrom, 512) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.route_from, 512),
    active_facility_id:
      asUuidOrNull(event.activeFacilityId) ||
      asUuidOrNull((event.metadata as Record<string, unknown> | null | undefined)?.active_facility_id as string | null | undefined),
    failing_chunk_url:
      clampText(event.failingChunkUrl, 512) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.failing_chunk_url, 512),
    boundary_name:
      clampText(event.boundaryName, 160) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.boundary_name, 160),
    component_stack:
      clampText(event.componentStack, 4000) ||
      clampText((event.metadata as Record<string, unknown> | null | undefined)?.component_stack, 4000),
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
