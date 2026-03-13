/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const FACILITY_ID = '11111111-1111-4111-8111-111111111111';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const dhis2Module = await import('../dhis2');
  const configModule = await import('../../config/supabase');
  return {
    dhis2Router: dhis2Module.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

const buildApp = (router: any) => {
  const app = express();
  app.use(express.json());
  app.use('/api/dhis2', router);
  return app;
};

const buildThenable = (result: any) => ({
  then(onFulfilled: any, onRejected: any) {
    return Promise.resolve(result).then(onFulfilled, onRejected);
  },
});

test('DHIS2 test-connection route verifies upstream system and user metadata', async () => {
  const { dhis2Router, supabaseAdmin } = await loadModules();
  const app = buildApp(dhis2Router);
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;
  const originalFetch = globalThis.fetch;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };
    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'users') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle: async () => ({
            data: {
              id: 'profile-1',
              tenant_id: 'tenant-1',
              facility_id: FACILITY_ID,
              user_role: 'medical_director',
            },
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    };

    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      fetchCalls.push(url);

      if (url.includes('/system/info.json')) {
        return new Response(
          JSON.stringify({
            version: '2.41.7',
            serverDate: '2026-03-13T09:26:54.528',
            calendar: 'iso8601',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('/me.json')) {
        return new Response(
          JSON.stringify({
            id: 'dhis2-user-1',
            username: 'demo_en',
            name: 'Demo User',
            authorities: ['F_DATAVALUE_ADD'],
            organisationUnits: [{ id: 'IWp9dQGM0bS', name: 'Lao PDR', level: 1, path: '/IWp9dQGM0bS' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch call ${url}`);
    }) as any;

    const response = await request(app)
      .post('/api/dhis2/test-connection')
      .set('authorization', 'Bearer valid-token')
      .send({
        connection: {
          baseUrl: 'https://demos.dhis2.org/hmis',
          authMode: 'basic',
          username: 'demo_en',
          password: 'District1#',
        },
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.system.version, '2.41.7');
    assert.equal(response.body.user.username, 'demo_en');
    assert.equal(response.body.organisationUnits[0].id, 'IWp9dQGM0bS');
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls.every((url) => url.startsWith('https://demos.dhis2.org/hmis/api/')));
  } finally {
    globalThis.fetch = originalFetch;
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('DHIS2 metadata route returns dataset metadata from the live client abstraction', async () => {
  const { dhis2Router, supabaseAdmin } = await loadModules();
  const app = buildApp(dhis2Router);
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;
  const originalFetch = globalThis.fetch;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };
    (supabaseAdmin as any).from = () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      limit() {
        return this;
      },
      maybeSingle: async () => ({
        data: {
              id: 'profile-1',
              tenant_id: 'tenant-1',
              facility_id: FACILITY_ID,
              user_role: 'medical_director',
            },
        error: null,
      }),
    });

    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('/system/info.json')) {
        return new Response(JSON.stringify({ version: '2.41.7' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/me.json')) {
        return new Response(
          JSON.stringify({
            id: 'dhis2-user-1',
            username: 'demo_en',
            name: 'Demo User',
            authorities: ['F_DATAVALUE_ADD'],
            organisationUnits: [{ id: 'IWp9dQGM0bS', name: 'Lao PDR', level: 1, path: '/IWp9dQGM0bS' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/dataSets/cTpVOPsjStW.json')) {
        return new Response(
          JSON.stringify({
            id: 'cTpVOPsjStW',
            name: 'CH - Maternal Health (Monthly)',
            periodType: 'Monthly',
            dataSetElements: [
              {
                dataElement: {
                  id: 'kM31fLP0SbL',
                  name: 'CH035a - Pregnant women who have 1st ANC contact with CHW during first trimester',
                  valueType: 'INTEGER_ZERO_OR_POSITIVE',
                  aggregationType: 'SUM',
                  categoryCombo: {
                    id: 'sF9PvilIV30',
                    name: 'default',
                    categoryOptionCombos: [{ id: 'odVfPr260P0', name: 'default' }],
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch call ${url}`);
    }) as any;

    const response = await request(app)
      .post('/api/dhis2/metadata')
      .set('authorization', 'Bearer valid-token')
      .send({
        connection: {
          baseUrl: 'https://demos.dhis2.org/hmis/api',
          authMode: 'basic',
          username: 'demo_en',
          password: 'District1#',
        },
        dataSetId: 'cTpVOPsjStW',
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.dataSet.id, 'cTpVOPsjStW');
    assert.equal(response.body.dataSet.periodType, 'Monthly');
    assert.equal(response.body.dataSet.dataElements[0].id, 'kM31fLP0SbL');
  } finally {
    globalThis.fetch = originalFetch;
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('DHIS2 submit route sends mapped data values and persists the submission batch', async () => {
  const { dhis2Router, supabaseAdmin } = await loadModules();
  const app = buildApp(dhis2Router);
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;
  const originalFetch = globalThis.fetch;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    const upsertCalls: any[] = [];
    const facilityUpdates: any[] = [];

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'users') {
        let authUserId = '';
        let facilityId = '';
        return {
          select() {
            return this;
          },
          eq(column: string, value: string) {
            if (column === 'auth_user_id') authUserId = value;
            if (column === 'facility_id') facilityId = value;
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle: async () => ({
            data:
              authUserId === 'auth-user-1' && (!facilityId || facilityId === FACILITY_ID)
                ? {
                    id: 'profile-1',
                    tenant_id: 'tenant-1',
                    facility_id: FACILITY_ID,
                    user_role: 'medical_director',
                  }
                : null,
            error: null,
          }),
        };
      }

      if (table === 'facilities') {
        let operation = 'select';
        const state: Record<string, string> = {};
        const builder: any = {
          select() {
            operation = 'select';
            return builder;
          },
          update(payload: any) {
            operation = 'update';
            facilityUpdates.push(payload);
            return builder;
          },
          eq(column: string, value: string) {
            state[column] = value;
            return builder;
          },
          maybeSingle: async () => ({
            data:
              operation === 'select' && state.id === FACILITY_ID
                ? {
                    id: FACILITY_ID,
                    tenant_id: 'tenant-1',
                    dhis2_org_unit_uid: null,
                  }
                : null,
            error: null,
          }),
          then(onFulfilled: any, onRejected: any) {
            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
          },
        };
        return builder;
      }

      if (table === 'dhis2_data_values') {
        return {
          upsert(rows: any[], _options: any) {
            upsertCalls.push(rows);
            return buildThenable({ data: rows, error: null });
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    };

    const fetchCalls: Array<{ url: string; method: string; body?: any }> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const method = String(init?.method || 'GET');
      const body = init?.body ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url.includes('/dataSets/So0EIjsa4Eq.json')) {
        return new Response(
          JSON.stringify({
            id: 'So0EIjsa4Eq',
            name: 'CH - Malaria (Monthly)',
            periodType: 'Monthly',
            dataSetElements: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.includes('/dataValueSets?')) {
        return new Response(
          JSON.stringify({
            httpStatus: 'OK',
            response: {
              status: 'SUCCESS',
              description: 'Import process completed successfully',
              importCount: {
                imported: 5,
                updated: 0,
                ignored: 0,
                deleted: 0,
              },
              conflicts: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      throw new Error(`Unexpected fetch call ${url}`);
    }) as any;

    const response = await request(app)
      .post('/api/dhis2/submit')
      .set('authorization', 'Bearer valid-token')
      .send({
        facilityId: FACILITY_ID,
        connection: {
          baseUrl: 'https://demos.dhis2.org/hmis/api',
          authMode: 'basic',
          username: 'demo_en',
          password: 'District1#',
          orgUnit: 'IWp9dQGM0bS',
          dataSetId: 'So0EIjsa4Eq',
          completeDataSet: true,
          dryRun: false,
        },
        report: {
          program: 'MALARIA',
          period: '202603',
          completeDate: '2026-03-13',
          comment: 'Goro malaria submission',
          values: {
            MAL_TESTS: 280,
            MAL_POS: 250,
            MAL_TX: 250,
            MAL_SEV: 30,
            IPTP2P: 0,
          },
          mappings: {
            MAL_TESTS: {
              dataElement: 'Yu2FXHo0dBD',
              categoryOptionCombo: 'OvAkh3z7dqK',
              attributeOptionCombo: 'OvAkh3z7dqK',
            },
            MAL_POS: {
              dataElement: 'lYX5lbthWyb',
              categoryOptionCombo: 'OvAkh3z7dqK',
              attributeOptionCombo: 'OvAkh3z7dqK',
            },
            MAL_TX: {
              dataElement: 'QDEOUuQAp3x',
              categoryOptionCombo: 'AhqePctFfDf',
              attributeOptionCombo: 'AhqePctFfDf',
            },
            MAL_SEV: {
              dataElement: 'cYZJhpewuMd',
              categoryOptionCombo: 'ivcH2j1hefL',
              attributeOptionCombo: 'ivcH2j1hefL',
            },
            IPTP2P: {
              dataElement: 'K3NyAKGJGxz',
              categoryOptionCombo: 'UlTNK9Wi7bK',
              attributeOptionCombo: 'UlTNK9Wi7bK',
            },
          },
          review: {
            notes: 'Reviewed by Goro leadership',
          },
        },
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.dryRun, false);
    assert.equal(response.body.importSummary.importCount.imported, 5);
    assert.equal(response.body.persistedRows, 5);
    assert.ok(typeof response.body.batchId === 'string' && response.body.batchId.startsWith('dhis2-malaria-'));
    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].length, 5);
    assert.equal(upsertCalls[0][0].org_unit_uid, 'IWp9dQGM0bS');
    assert.equal(upsertCalls[0][0].is_submitted, true);
    assert.equal(facilityUpdates.length, 1);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1].method, 'POST');
    assert.equal(fetchCalls[1].body.dataSet, 'So0EIjsa4Eq');
    assert.equal(fetchCalls[1].body.dataValues[0].dataElement, 'Yu2FXHo0dBD');
    assert.equal(fetchCalls[1].body.dataValues[0].value, '280');
  } finally {
    globalThis.fetch = originalFetch;
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('DHIS2 config route returns facility-scoped settings without secrets', async () => {
  const { dhis2Router, supabaseAdmin } = await loadModules();
  const app = buildApp(dhis2Router);
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'users') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle: async () => ({
            data: {
              id: 'profile-1',
              tenant_id: 'tenant-1',
              facility_id: FACILITY_ID,
              user_role: 'clinic_admin',
            },
            error: null,
          }),
        };
      }

      if (table === 'facilities') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({
            data: {
              id: FACILITY_ID,
              tenant_id: 'tenant-1',
              dhis2_org_unit_uid: 'IWp9dQGM0bS',
            },
            error: null,
          }),
        };
      }

      if (table === 'tenants') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: async () => ({
            data: {
              settings: {
                dhis2: {
                  connection: {
                    baseUrl: 'https://demos.dhis2.org/hmis/api',
                    authMode: 'basic',
                    username: 'demo_en',
                    password: 'secret-password',
                    personalAccessToken: '',
                    dataSetId: 'So0EIjsa4Eq',
                    completeDataSet: true,
                    dryRun: false,
                    periodOverride: '202603',
                  },
                  mappingsByProgram: {
                    MALARIA: {
                      MAL_TESTS: {
                        dataElement: 'Yu2FXHo0dBD',
                        categoryOptionCombo: 'OvAkh3z7dqK',
                        attributeOptionCombo: 'OvAkh3z7dqK',
                      },
                    },
                  },
                },
              },
            },
            error: null,
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    };

    const response = await request(app)
      .get(`/api/dhis2/config?facilityId=${FACILITY_ID}`)
      .set('authorization', 'Bearer valid-token');

    assert.equal(response.status, 200);
    assert.equal(response.body.configured, true);
    assert.equal(response.body.orgUnitRef, 'IWp9dQGM0bS');
    assert.equal(response.body.connection.baseUrl, 'https://demos.dhis2.org/hmis/api');
    assert.equal(response.body.connection.hasPassword, true);
    assert.equal('password' in response.body.connection, false);
    assert.equal(response.body.mappingsByProgram.MALARIA.MAL_TESTS.dataElement, 'Yu2FXHo0dBD');
  } finally {
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('DHIS2 config update preserves saved secrets when admin leaves them blank', async () => {
  const { dhis2Router, supabaseAdmin } = await loadModules();
  const app = buildApp(dhis2Router);
  const originalAuth = (supabaseAdmin as any).auth;
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    const tenantUpdates: any[] = [];
    const facilityUpdates: any[] = [];

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'users') {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          limit() {
            return this;
          },
          maybeSingle: async () => ({
            data: {
              id: 'profile-1',
              tenant_id: 'tenant-1',
              facility_id: FACILITY_ID,
              user_role: 'clinic_admin',
            },
            error: null,
          }),
        };
      }

      if (table === 'facilities') {
        let operation = 'select';
        const builder: any = {
          select() {
            operation = 'select';
            return builder;
          },
          update(payload: any) {
            operation = 'update';
            facilityUpdates.push(payload);
            return builder;
          },
          eq() {
            return builder;
          },
          maybeSingle: async () => ({
            data:
              operation === 'select'
                ? {
                    id: FACILITY_ID,
                    tenant_id: 'tenant-1',
                    dhis2_org_unit_uid: 'IWp9dQGM0bS',
                  }
                : null,
            error: null,
          }),
          then(onFulfilled: any, onRejected: any) {
            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
          },
        };
        return builder;
      }

      if (table === 'tenants') {
        let operation = 'select';
        const builder: any = {
          select() {
            operation = 'select';
            return builder;
          },
          update(payload: any) {
            operation = 'update';
            tenantUpdates.push(payload);
            return builder;
          },
          eq() {
            return builder;
          },
          maybeSingle: async () => ({
            data:
              operation === 'select'
                ? {
                    settings: {
                      dhis2: {
                        connection: {
                          baseUrl: 'https://demos.dhis2.org/hmis/api',
                          authMode: 'basic',
                          username: 'demo_en',
                          password: 'persist-me',
                          personalAccessToken: '',
                          dataSetId: 'So0EIjsa4Eq',
                          completeDataSet: true,
                          dryRun: false,
                          periodOverride: '202603',
                        },
                        mappingsByProgram: {},
                      },
                    },
                  }
                : null,
            error: null,
          }),
          then(onFulfilled: any, onRejected: any) {
            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
          },
        };
        return builder;
      }

      throw new Error(`Unexpected table ${table}`);
    };

    const response = await request(app)
      .put('/api/dhis2/config')
      .set('authorization', 'Bearer valid-token')
      .send({
        facilityId: FACILITY_ID,
        orgUnitRef: 'IWp9dQGM0bS',
        connection: {
          baseUrl: 'https://demos.dhis2.org/hmis/api',
          authMode: 'basic',
          username: 'demo_en',
          password: '',
          dataSetId: 'So0EIjsa4Eq',
          completeDataSet: true,
          dryRun: false,
          periodOverride: '202603',
        },
        mappingsByProgram: {
          MALARIA: {
            MAL_TESTS: {
              dataElement: 'Yu2FXHo0dBD',
              categoryOptionCombo: 'OvAkh3z7dqK',
              attributeOptionCombo: 'OvAkh3z7dqK',
            },
          },
        },
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.connection.hasPassword, true);
    assert.equal(tenantUpdates.length, 1);
    assert.equal(
      tenantUpdates[0].settings.dhis2.connection.password,
      'persist-me'
    );
    assert.equal(facilityUpdates.length, 1);
    assert.equal(facilityUpdates[0].dhis2_org_unit_uid, 'IWp9dQGM0bS');
  } finally {
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).from = originalFrom;
  }
});
