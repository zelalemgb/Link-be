type MetricWindow = {
  startedAt: number;
  total: number;
  errors: number;
  authFailures: number;
  auditFailures: number;
  alertedErrorRate: boolean;
  alertedAuthFailures: boolean;
  alertedAuditFailures: boolean;
};

const windowMs = Number(process.env.MONITORING_WINDOW_MS || 60_000);
const errorRateThreshold = Number(process.env.ALERT_ERROR_RATE_THRESHOLD || 0.05);
const authFailureThreshold = Number(process.env.ALERT_AUTH_FAILURE_THRESHOLD || 20);
const auditFailureThreshold = Number(process.env.ALERT_AUDIT_FAILURE_THRESHOLD || 5);
const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL || '';

const windowState: MetricWindow = {
  startedAt: Date.now(),
  total: 0,
  errors: 0,
  authFailures: 0,
  auditFailures: 0,
  alertedErrorRate: false,
  alertedAuthFailures: false,
  alertedAuditFailures: false,
};

const resetWindowIfNeeded = () => {
  const now = Date.now();
  if (now - windowState.startedAt >= windowMs) {
    windowState.startedAt = now;
    windowState.total = 0;
    windowState.errors = 0;
    windowState.authFailures = 0;
    windowState.auditFailures = 0;
    windowState.alertedErrorRate = false;
    windowState.alertedAuthFailures = false;
    windowState.alertedAuditFailures = false;
  }
};

const sendAlert = async (payload: Record<string, unknown>) => {
  if (!alertWebhookUrl) return;
  try {
    await fetch(alertWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Alert webhook failed:', (error as Error).message || error);
  }
};

export const recordResponseStatus = async (status: number, requestId?: string) => {
  resetWindowIfNeeded();
  windowState.total += 1;
  if (status >= 500) {
    windowState.errors += 1;
  }

  if (!windowState.alertedErrorRate && windowState.total >= 20) {
    const rate = windowState.errors / windowState.total;
    if (rate >= errorRateThreshold) {
      windowState.alertedErrorRate = true;
      await sendAlert({
        type: 'error_rate',
        rate,
        total: windowState.total,
        errors: windowState.errors,
        window_ms: windowMs,
        request_id: requestId || null,
        timestamp: new Date().toISOString(),
      });
    }
  }
};

export const recordAuthFailure = async (requestId?: string) => {
  resetWindowIfNeeded();
  windowState.authFailures += 1;
  if (!windowState.alertedAuthFailures && windowState.authFailures >= authFailureThreshold) {
    windowState.alertedAuthFailures = true;
    await sendAlert({
      type: 'auth_failures',
      count: windowState.authFailures,
      window_ms: windowMs,
      request_id: requestId || null,
      timestamp: new Date().toISOString(),
    });
  }
};

export const recordAuditFailure = async (requestId?: string) => {
  resetWindowIfNeeded();
  windowState.auditFailures += 1;
  if (!windowState.alertedAuditFailures && windowState.auditFailures >= auditFailureThreshold) {
    windowState.alertedAuditFailures = true;
    await sendAlert({
      type: 'audit_failures',
      count: windowState.auditFailures,
      window_ms: windowMs,
      request_id: requestId || null,
      timestamp: new Date().toISOString(),
    });
  }
};

export const getMonitoringSnapshot = () => {
  resetWindowIfNeeded();
  return {
    window_started_at: new Date(windowState.startedAt).toISOString(),
    window_ms: windowMs,
    total_requests: windowState.total,
    error_responses: windowState.errors,
    auth_failures: windowState.authFailures,
    audit_failures: windowState.auditFailures,
  };
};
