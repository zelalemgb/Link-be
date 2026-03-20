import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const { csrfProtection } = await import('../../middleware/csrf');
  const routerModule = await import('../platform-audit');
  const configModule = await import('../../config/supabase');
  return {
    csrfProtection,
    platformAuditRouter: routerModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('platform audit events are accepted without CSRF and persist scoped activity rows', async () => {
  const { csrfProtection, platformAuditRouter, supabaseAdmin } = await loadModules();
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

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.cookies = {};
      next();
    });
    app.use(csrfProtection);
    app.use('/api/platform-audit', platformAuditRouter);

    const response = await request(app)
      .post('/api/platform-audit/events')
      .send({
        events: [
          {
            sessionId: '11111111-1111-4111-8111-111111111111',
            category: 'action',
            eventName: 'action.goro_quick_access.clicked',
            outcome: 'started',
            actorEmail: 'goro@example.com',
            actorRole: 'clinic_admin',
            actorUserId: '22222222-2222-4222-8222-222222222222',
            actorAuthUserId: '33333333-3333-4333-8333-333333333333',
            tenantId: '44444444-4444-4444-8444-444444444444',
            facilityId: '55555555-5555-4555-8555-555555555555',
          pagePath: '/',
          entryPoint: 'goro_testing_quick_access',
          frontendReleaseSha: 'web-release-123',
          frontendAssetBundle: 'assets/index-abc123.js',
          serviceWorkerState: 'active',
          serviceWorkerScriptUrl: 'https://linkhc.org/sw.js',
          networkOnline: true,
          networkEffectiveType: '4g',
          authBootstrapPhase: 'facility_loaded',
          scopeSource: 'db',
          requestId: '66666666-6666-4666-8666-666666666666',
          errorFingerprint: 'fp-action-goro',
          failureKind: 'http_response',
          serverDecisionReason: 'role_forbidden',
          routeFrom: '/auth',
          activeFacilityId: '55555555-5555-4555-8555-555555555555',
          failingChunkUrl: 'https://linkhc.org/assets/chunk.js',
          boundaryName: 'RootBoundary',
          componentStack: 'at Root\nat Child',
          metadata: {
              accountTitle: 'Clinic Admin',
          },
          },
        ],
      });

    assert.equal(response.status, 202);
    assert.equal(response.body.accepted, 1);
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].event_name, 'action.goro_quick_access.clicked');
    assert.equal(insertedRows[0].actor_email, 'goro@example.com');
    assert.equal(insertedRows[0].tenant_id, '44444444-4444-4444-8444-444444444444');
    assert.equal(insertedRows[0].facility_id, '55555555-5555-4555-8555-555555555555');
    assert.equal(insertedRows[0].frontend_release_sha, 'web-release-123');
    assert.equal(insertedRows[0].frontend_asset_bundle, 'assets/index-abc123.js');
    assert.equal(insertedRows[0].service_worker_state, 'active');
    assert.equal(insertedRows[0].network_online, true);
    assert.equal(insertedRows[0].request_id, '66666666-6666-4666-8666-666666666666');
    assert.equal(insertedRows[0].failure_kind, 'http_response');
    assert.equal(insertedRows[0].server_decision_reason, 'role_forbidden');
    assert.equal(insertedRows[0].route_from, '/auth');
    assert.equal(insertedRows[0].boundary_name, 'RootBoundary');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
