import test from 'node:test';
import assert from 'node:assert/strict';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.RELEASE_SHA = 'backend-release-sha';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const serviceModule = await import('../../services/platform-activity');
  const configModule = await import('../../config/supabase');
  return {
    recordPlatformActivityEvents: serviceModule.recordPlatformActivityEvents,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('platform activity persists observability fields and preserves distinct frontend/backend releases', async () => {
  const { recordPlatformActivityEvents, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    const insertedRows: any[] = [];
    (supabaseAdmin as any).from = (table: string) => {
      assert.equal(table, 'platform_activity_log');
      return {
        insert: async (rows: any[]) => {
          insertedRows.push(...rows);
          return { error: null };
        },
      };
    };

    await recordPlatformActivityEvents([
      {
        sessionId: '11111111-1111-4111-8111-111111111111',
        category: 'api',
        eventName: 'api.request.failed',
        outcome: 'failure',
        pagePath: '/clinic-admin',
        requestPath: '/api/subscription/status',
        responseStatus: 403,
        errorMessage: 'Missing tenant or facility context',
        frontendReleaseSha: 'frontend-release-sha',
        frontendAssetBundle: 'assets/index-prod.js',
        serviceWorkerState: 'active',
        networkOnline: true,
        authBootstrapPhase: 'metadata_fallback',
        scopeSource: 'auth_metadata',
        requestId: '22222222-2222-4222-8222-222222222222',
        routeFrom: '/auth',
        activeFacilityId: '33333333-3333-4333-8333-333333333333',
        serverDecisionReason: 'missing_scope_context',
      },
    ]);

    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].frontend_release_sha, 'frontend-release-sha');
    assert.equal(insertedRows[0].backend_release_sha, 'backend-release-sha');
    assert.equal(insertedRows[0].frontend_asset_bundle, 'assets/index-prod.js');
    assert.equal(insertedRows[0].service_worker_state, 'active');
    assert.equal(insertedRows[0].network_online, true);
    assert.equal(insertedRows[0].auth_bootstrap_phase, 'metadata_fallback');
    assert.equal(insertedRows[0].scope_source, 'auth_metadata');
    assert.equal(insertedRows[0].request_id, '22222222-2222-4222-8222-222222222222');
    assert.equal(insertedRows[0].failure_kind, 'http_response');
    assert.equal(insertedRows[0].server_decision_reason, 'missing_scope_context');
    assert.equal(insertedRows[0].route_from, '/auth');
    assert.equal(insertedRows[0].active_facility_id, '33333333-3333-4333-8333-333333333333');
    assert.equal(insertedRows[0].metadata.frontend_release_sha, 'frontend-release-sha');
    assert.equal(insertedRows[0].metadata.backend_release_sha, 'backend-release-sha');
    assert.equal(insertedRows[0].metadata.failure_kind, 'http_response');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('platform activity derives transport failure kind from failed fetch errors', async () => {
  const { recordPlatformActivityEvents, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    const insertedRows: any[] = [];
    (supabaseAdmin as any).from = () => ({
      insert: async (rows: any[]) => {
        insertedRows.push(...rows);
        return { error: null };
      },
    });

    await recordPlatformActivityEvents([
      {
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        category: 'api',
        eventName: 'api.request.failed',
        outcome: 'failure',
        errorMessage: 'Failed to fetch',
      },
    ]);

    assert.equal(insertedRows[0].failure_kind, 'transport');
    assert.equal(insertedRows[0].metadata.failure_kind, 'transport');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
