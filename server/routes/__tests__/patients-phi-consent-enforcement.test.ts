import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const patientsRouteModule = await import('../patients');
  const configModule = await import('../../config/supabase');
  return {
    patientsRouter: patientsRouteModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

const buildApp = (patientsRouter: any) => {
  const app = express();
  app.use(express.json());
  app.use('/api/patients', patientsRouter);
  return app;
};

test('provider PHI read is consent-gated for portal-linked patients (deny -> allow -> deny after revoke)', async () => {
  const { patientsRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const patientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const patientAccountId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  let consentState: 'missing' | 'active' | 'revoked' = 'missing';

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: any = { filters: {}, orders: [], operation: 'select', payload: null };
      const query: any = {
        select() {
          state.operation = 'select';
          return query;
        },
        eq(column: string, value: any) {
          state.filters[column] = value;
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          state.orders.push({ column, ascending: options?.ascending !== false });
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: { id: 'profile-1', tenant_id: tenantId, facility_id: facilityId, user_role: 'doctor' },
              error: null,
            };
          }
          if (table === 'patients') {
            return { data: { id: patientId, patient_account_id: patientAccountId }, error: null };
          }
          if (table === 'facilities') {
            return { data: { id: facilityId, tenant_id: tenantId }, error: null };
          }
          if (table === 'patient_portal_consents') {
            if (consentState === 'missing') return { data: null, error: null };
            return { data: { id: 'consent-1', is_active: consentState === 'active' }, error: null };
          }
          return { data: null, error: null };
        },
        then: (onFulfilled: any, onRejected: any) => {
          if (table === 'visits') {
            return Promise.resolve({
              data: [
                {
                  id: 'visit-1',
                  visit_date: '2026-02-15',
                  reason: 'Checkup',
                  status: 'doctor',
                  provider: 'Dr. A',
                },
              ],
              error: null,
            }).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        },
      };
      return query;
    };

    const app = buildApp(patientsRouter);

    const deny1 = await request(app)
      .get(`/api/patients/${patientId}/visits/history?limit=1`)
      .set('authorization', 'Bearer valid-token');
    assert.equal(deny1.status, 403);
    assert.deepEqual(deny1.body, {
      code: 'PERM_PHI_CONSENT_REQUIRED',
      message: 'Patient portal consent is required',
    });

    consentState = 'active';
    const allow = await request(app)
      .get(`/api/patients/${patientId}/visits/history?limit=1`)
      .set('authorization', 'Bearer valid-token');
    assert.equal(allow.status, 200);
    assert.ok(Array.isArray(allow.body));
    assert.equal(allow.body[0].id, 'visit-1');

    consentState = 'revoked';
    const deny2 = await request(app)
      .get(`/api/patients/${patientId}/visits/history?limit=1`)
      .set('authorization', 'Bearer valid-token');
    assert.equal(deny2.status, 409);
    assert.deepEqual(deny2.body, {
      code: 'CONFLICT_CONSENT_ACCESS_REVOKED',
      message: 'Consent access has been revoked',
    });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('provider patient search is consent-filtered for portal-linked PHI records (deny -> allow -> deny after revoke)', async () => {
  const { patientsRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const patientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const patientAccountId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  let consentState: 'missing' | 'active' | 'revoked' = 'missing';

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: any = { filters: {}, orders: [], operation: 'select', payload: null };
      const query: any = {
        select() {
          state.operation = 'select';
          return query;
        },
        eq(column: string, value: any) {
          state.filters[column] = value;
          return query;
        },
        or() {
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          state.orders.push({ column, ascending: options?.ascending !== false });
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: { id: 'profile-1', tenant_id: tenantId, facility_id: facilityId, user_role: 'doctor' },
              error: null,
            };
          }
          if (table === 'patients') {
            if (state.filters.id) {
              return { data: { id: patientId, patient_account_id: patientAccountId }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === 'facilities') {
            return { data: { id: facilityId, tenant_id: tenantId }, error: null };
          }
          if (table === 'patient_portal_consents') {
            if (consentState === 'missing') return { data: null, error: null };
            return { data: { id: 'consent-1', is_active: consentState === 'active' }, error: null };
          }
          return { data: null, error: null };
        },
        then: (onFulfilled: any, onRejected: any) => {
          if (table === 'patients') {
            return Promise.resolve({
              data: [
                {
                  id: patientId,
                  first_name: 'Jane',
                  last_name: 'Doe',
                  full_name: 'Jane Doe',
                  fayida_id: 'FAY-001',
                  date_of_birth: '1990-01-01',
                  gender: 'F',
                  phone: '+251900000001',
                  visits: [],
                },
              ],
              error: null,
            }).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        },
      };
      return query;
    };

    const app = buildApp(patientsRouter);

    const deny1 = await request(app)
      .get('/api/patients/search?q=ja')
      .set('authorization', 'Bearer valid-token');
    assert.equal(deny1.status, 200);
    assert.deepEqual(deny1.body, []);

    consentState = 'active';
    const allow = await request(app)
      .get('/api/patients/search?q=ja')
      .set('authorization', 'Bearer valid-token');
    assert.equal(allow.status, 200);
    assert.equal(Array.isArray(allow.body), true);
    assert.equal(allow.body.length, 1);
    assert.equal(allow.body[0].id, patientId);

    consentState = 'revoked';
    const deny2 = await request(app)
      .get('/api/patients/search?q=ja')
      .set('authorization', 'Bearer valid-token');
    assert.equal(deny2.status, 200);
    assert.deepEqual(deny2.body, []);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('provider active-visit order read remains available with consent override marker', async () => {
  const { patientsRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const visitId = '11111111-1111-4111-8111-111111111111';
  const patientId = '22222222-2222-4222-8222-222222222222';
  const patientAccountId = '33333333-3333-4333-8333-333333333333';

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: any = { filters: {} };
      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: any) {
          state.filters[column] = value;
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: { id: 'profile-1', tenant_id: tenantId, facility_id: facilityId, user_role: 'doctor' },
              error: null,
            };
          }
          if (table === 'visits') {
            return {
              data: { id: visitId, tenant_id: tenantId, facility_id: facilityId, patient_id: patientId },
              error: null,
            };
          }
          if (table === 'patients') {
            return { data: { id: patientId, patient_account_id: patientAccountId }, error: null };
          }
          if (table === 'facilities') {
            return { data: { id: facilityId, tenant_id: tenantId }, error: null };
          }
          if (table === 'patient_portal_consents') {
            // Missing consent should map to PERM_PHI_CONSENT_REQUIRED.
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        then: (onFulfilled: any, onRejected: any) => {
          if (table === 'lab_orders') {
            return Promise.resolve({
              data: [
                {
                  id: 'lab-1',
                  test_name: 'CBC',
                  test_code: 'CBC',
                  urgency: 'routine',
                  status: 'pending',
                  result: null,
                  result_value: null,
                  reference_range: null,
                  ordered_at: '2026-02-15T00:00:00.000Z',
                  collected_at: null,
                  completed_at: null,
                  payment_status: 'unpaid',
                  payment_mode: null,
                  amount: 100,
                  paid_at: null,
                  notes: null,
                  sent_outside: false,
                },
              ],
              error: null,
            }).then(onFulfilled, onRejected);
          }
          if (table === 'imaging_orders') {
            return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
          }
          if (table === 'medication_orders') {
            return Promise.resolve({
              data: [
                {
                  id: 'med-1',
                  medication_name: 'Paracetamol',
                  generic_name: null,
                  dosage: '500 mg',
                  frequency: 'TID',
                  route: 'oral',
                  duration: '3 days',
                  quantity: 9,
                  refills: 0,
                  status: 'pending',
                  notes: null,
                  ordered_at: '2026-02-15T00:00:00.000Z',
                  dispensed_at: null,
                  payment_status: 'unpaid',
                  payment_mode: null,
                  amount: 80,
                  paid_at: null,
                  sent_outside: false,
                },
              ],
              error: null,
            }).then(onFulfilled, onRejected);
          }
          if (table === 'billing_items') {
            return Promise.resolve({
              data: [
                {
                  id: 'bill-1',
                  payment_status: 'unpaid',
                  medical_services: { name: 'Procedure A', category: 'Procedures' },
                },
              ],
              error: null,
            }).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        },
      };
      return query;
    };

    const app = buildApp(patientsRouter);

    const response = await request(app)
      .get(`/api/patients/visits/${visitId}/orders`)
      .set('authorization', 'Bearer valid-token');

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body?.consent_override, 'PERM_PHI_CONSENT_REQUIRED');
    assert.equal(Array.isArray(response.body?.labOrders), true);
    assert.equal(response.body.labOrders.length, 1);
    assert.equal(Array.isArray(response.body?.medicationOrders), true);
    assert.equal(response.body.medicationOrders.length, 1);
    assert.equal(Array.isArray(response.body?.procedureOrders), true);
    assert.equal(response.body.procedureOrders.length, 1);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});
