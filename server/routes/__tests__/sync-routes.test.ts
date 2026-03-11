import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import * as crypto from 'node:crypto';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

const toBase64Url = (value: Buffer | string) => {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

const signHubSessionToken = (payload: Record<string, unknown>, privateKeyPem: string) => {
  const header = toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = toBase64Url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${signingInput}.${toBase64Url(signature)}`;
};

type QueryState = {
  table: string;
  operation: 'select' | 'upsert';
  selectColumns?: string;
  filters: Record<string, any>;
  inFilters: Record<string, any[]>;
  gtFilters: Record<string, any>;
  orderBy?: { column: string; ascending: boolean };
  limit?: number;
  payload?: any;
  upsertOptions?: any;
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const syncRouteModule = await import('../sync');
  const configModule = await import('../../config/supabase');
  return {
    syncRouter: syncRouteModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('W2-BE-020 sync push ingests ops idempotently by opId', async () => {
  const { syncRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const profileId = '99999999-9999-4999-8999-999999999999';

  let seqCounter = 0;
  const ledger: any[] = [];
  let upsertCalls = 0;

  const createFromStub = (table: string) => {
    const state: QueryState = {
      table,
      operation: 'select',
      filters: {},
      inFilters: {},
      gtFilters: {},
    };

    const query: any = {
      select(columns?: string) {
        state.selectColumns = columns;
        state.operation = 'select';
        return query;
      },
      eq(column: string, value: any) {
        state.filters[column] = value;
        return query;
      },
      in(column: string, values: any[]) {
        state.inFilters[column] = values;
        return query;
      },
      gt(column: string, value: any) {
        state.gtFilters[column] = value;
        return query;
      },
      order(column: string, options?: { ascending?: boolean }) {
        state.orderBy = { column, ascending: options?.ascending !== false };
        return query;
      },
      limit(value: number) {
        state.limit = value;
        return query;
      },
      upsert(payload: any, options?: any) {
        state.operation = 'upsert';
        state.payload = payload;
        state.upsertOptions = options;
        return query;
      },
      maybeSingle: async () => {
        if (table === 'users') {
          return {
            data: {
              id: profileId,
              tenant_id: tenantId,
              facility_id: facilityId,
              user_role: 'doctor',
            },
            error: null,
          };
        }
        if (table === 'facilities') {
          return {
            data: { id: facilityId, tenant_id: tenantId },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      then: (onFulfilled: any, onRejected: any) => {
        const execute = () => {
          if (table === 'sync_op_ledger') {
            if (state.operation === 'select') {
              const scoped = ledger.filter(
                (row) => row.tenant_id === state.filters.tenant_id && row.facility_id === state.filters.facility_id
              );

              if (state.inFilters.op_id) {
                const set = new Set(state.inFilters.op_id.map(String));
                return {
                  data: scoped
                    .filter((row) => set.has(String(row.op_id)))
                    .map((row) => ({ op_id: row.op_id, payload_hash: row.payload_hash })),
                  error: null,
                };
              }

              const after = typeof state.gtFilters.seq === 'number' ? state.gtFilters.seq : null;
              let rows = scoped;
              if (after !== null) {
                rows = rows.filter((row) => row.seq > after);
              }
              rows = rows.slice().sort((a, b) => a.seq - b.seq);
              if (typeof state.limit === 'number') {
                rows = rows.slice(0, state.limit);
              }
              return {
                data: rows.map((row) => ({
                  seq: row.seq,
                  op_id: row.op_id,
                  device_id: row.device_id,
                  payload: row.payload,
                  created_at: row.created_at,
                })),
                error: null,
              };
            }

            if (state.operation === 'upsert') {
              upsertCalls += 1;
              const rows = Array.isArray(state.payload) ? state.payload : [state.payload];
              for (const row of rows) {
                const exists = ledger.some(
                  (existing) =>
                    existing.tenant_id === row.tenant_id &&
                    existing.facility_id === row.facility_id &&
                    String(existing.op_id) === String(row.op_id)
                );
                if (exists) continue;
                seqCounter += 1;
                ledger.push({
                  seq: seqCounter,
                  tenant_id: row.tenant_id,
                  facility_id: row.facility_id,
                  op_id: row.op_id,
                  device_id: row.device_id,
                  payload: row.payload,
                  payload_hash: row.payload_hash,
                  created_at: `2026-02-17T00:00:0${seqCounter}.000Z`,
                });
              }
              return { data: [], error: null };
            }
          }

          return { data: [], error: null };
        };

        return Promise.resolve(execute()).then(onFulfilled, onRejected);
      },
    };

    return query;
  };

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: '11111111-1111-4111-8111-111111111111' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => createFromStub(table);

    const app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter);

    const payload = {
      facilityId,
      deviceId: 'device-1',
      ops: [
        {
          opId: '22222222-2222-4222-8222-222222222222',
          entityType: 'patients',
          entityId: '33333333-3333-4333-8333-333333333333',
          opType: 'upsert',
          data: { fullName: 'Test Patient' },
          clientCreatedAt: new Date().toISOString(),
        },
        {
          opId: '44444444-4444-4444-8444-444444444444',
          entityType: 'visits',
          entityId: '55555555-5555-4555-8555-555555555555',
          opType: 'upsert',
          data: { status: 'with_doctor' },
          clientCreatedAt: new Date().toISOString(),
        },
      ],
    };

    const res1 = await request(app)
      .post('/api/sync/push')
      .set('authorization', 'Bearer valid-token')
      .send(payload);

    assert.equal(res1.status, 200);
    assert.deepEqual(
      res1.body.results.map((r: any) => ({ opId: r.opId, status: r.status })),
      [
        { opId: '22222222-2222-4222-8222-222222222222', status: 'ingested' },
        { opId: '44444444-4444-4444-8444-444444444444', status: 'ingested' },
      ]
    );
    assert.equal(ledger.length, 2);
    assert.equal(upsertCalls, 1);

    const res2 = await request(app)
      .post('/api/sync/push')
      .set('authorization', 'Bearer valid-token')
      .send(payload);

    assert.equal(res2.status, 200);
    assert.deepEqual(
      res2.body.results.map((r: any) => ({ opId: r.opId, status: r.status })),
      [
        { opId: '22222222-2222-4222-8222-222222222222', status: 'duplicate' },
        { opId: '44444444-4444-4444-8444-444444444444', status: 'duplicate' },
      ]
    );
    assert.equal(ledger.length, 2);
    assert.equal(upsertCalls, 1);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('W2-BE-020 sync push accepts offline hub session JWT when cloud auth is unavailable', async () => {
  const { syncRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalPublicKey = process.env.LICENSE_RSA_PUBLIC_KEY;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const hubId = '66666666-6666-4666-8666-666666666666';
  const profileId = '99999999-9999-4999-8999-999999999999';
  let ledgerWrites = 0;

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.LICENSE_RSA_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const token = signHubSessionToken(
    {
      sub: hubId,
      tid: tenantId,
      fid: facilityId,
      pid: profileId,
      typ: 'hub_sync',
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  );

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: null },
        error: { status: 503, message: 'auth provider unavailable' },
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: QueryState = {
        table,
        operation: 'select',
        filters: {},
        inFilters: {},
        gtFilters: {},
      };

      const query: any = {
        select() {
          state.operation = 'select';
          return query;
        },
        eq(column: string, value: any) {
          state.filters[column] = value;
          return query;
        },
        in() {
          return query;
        },
        limit() {
          return query;
        },
        upsert() {
          state.operation = 'upsert';
          if (table === 'sync_op_ledger') {
            ledgerWrites += 1;
          }
          return query;
        },
        maybeSingle: async () => {
          if (table === 'hub_registrations') {
            return {
              data: {
                id: hubId,
                tenant_id: tenantId,
                facility_id: facilityId,
                is_active: true,
              },
              error: null,
            };
          }
          if (table === 'users') {
            return {
              data: {
                id: profileId,
                tenant_id: tenantId,
                facility_id: facilityId,
              },
              error: null,
            };
          }
          if (table === 'facilities') {
            return {
              data: { id: facilityId, tenant_id: tenantId },
              error: null,
            };
          }
          if (table === 'sync_op_ledger') {
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        then: (onFulfilled: any, onRejected: any) => {
          if (table === 'sync_op_ledger' && state.operation === 'select') {
            return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
          }
          if (table === 'sync_op_ledger' && state.operation === 'upsert') {
            return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        },
      };

      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter);

    const response = await request(app)
      .post('/api/sync/push')
      .set('authorization', `Bearer ${token}`)
      .send({
        facilityId,
        deviceId: 'hub-lan-device-1',
        ops: [
          {
            opId: '77777777-7777-4777-8777-777777777777',
            entityType: 'patients',
            entityId: '88888888-8888-4888-8888-888888888888',
            opType: 'upsert',
            data: { full_name: 'Hub Offline Patient', updated_at: new Date().toISOString() },
            clientCreatedAt: new Date().toISOString(),
          },
        ],
      });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(Array.isArray(response.body.results), true);
    assert.equal(response.body.results[0]?.status, 'ingested');
    assert.equal(ledgerWrites, 1);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    process.env.LICENSE_RSA_PUBLIC_KEY = originalPublicKey;
  }
});

test('W2-BE-020 sync push rejects cross-tenant facility access', async () => {
  const { syncRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  let ledgerWrites = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: '11111111-1111-4111-8111-111111111111' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: {
                id: '99999999-9999-4999-8999-999999999999',
                tenant_id: tenantId,
                facility_id: facilityId,
                user_role: 'doctor',
              },
              error: null,
            };
          }

          if (table === 'facilities') {
            return {
              data: { id: facilityId, tenant_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
              error: null,
            };
          }

          return { data: null, error: null };
        },
        in() {
          return query;
        },
        upsert() {
          ledgerWrites += 1;
          return query;
        },
        then: (onFulfilled: any, onRejected: any) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
      };
      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter);

    const response = await request(app)
      .post('/api/sync/push')
      .set('authorization', 'Bearer valid-token')
      .send({
        facilityId,
        deviceId: 'device-1',
        ops: [
          {
            opId: '22222222-2222-4222-8222-222222222222',
            entityType: 'patients',
            entityId: '33333333-3333-4333-8333-333333333333',
            opType: 'upsert',
            data: { fullName: 'Test Patient' },
            clientCreatedAt: new Date().toISOString(),
          },
        ],
      });

    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'TENANT_RESOURCE_SCOPE_VIOLATION');
    assert.equal(ledgerWrites, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('W2-BE-021 sync pull returns stable delta feed with cursor ordering', async () => {
  const { syncRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const facilityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ledger = [
    {
      seq: 1,
      tenant_id: tenantId,
      facility_id: facilityId,
      op_id: '22222222-2222-4222-8222-222222222222',
      device_id: 'device-1',
      payload: {
        opId: '22222222-2222-4222-8222-222222222222',
        entityType: 'patients',
        entityId: '33333333-3333-4333-8333-333333333333',
        opType: 'upsert',
        data: { fullName: 'Test Patient' },
        clientCreatedAt: '2026-02-17T00:00:00.000Z',
      },
      created_at: '2026-02-17T00:00:10.000Z',
      payload_hash: 'hash-1',
    },
    {
      seq: 2,
      tenant_id: tenantId,
      facility_id: facilityId,
      op_id: '44444444-4444-4444-8444-444444444444',
      device_id: 'device-1',
      payload: {
        opId: '44444444-4444-4444-8444-444444444444',
        entityType: 'visits',
        entityId: '55555555-5555-4555-8555-555555555555',
        opType: 'upsert',
        data: { status: 'with_doctor' },
        clientCreatedAt: '2026-02-17T00:00:01.000Z',
      },
      created_at: '2026-02-17T00:00:11.000Z',
      payload_hash: 'hash-2',
    },
  ];

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: '11111111-1111-4111-8111-111111111111' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: QueryState = {
        table,
        operation: 'select',
        filters: {},
        inFilters: {},
        gtFilters: {},
      };

      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: any) {
          state.filters[column] = value;
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: {
                id: '99999999-9999-4999-8999-999999999999',
                tenant_id: tenantId,
                facility_id: facilityId,
                user_role: 'doctor',
              },
              error: null,
            };
          }
          if (table === 'facilities') {
            return {
              data: { id: facilityId, tenant_id: tenantId },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        gt(column: string, value: any) {
          state.gtFilters[column] = value;
          return query;
        },
        order() {
          return query;
        },
        limit(value: number) {
          state.limit = value;
          return query;
        },
        then: (onFulfilled: any, onRejected: any) => {
          const execute = () => {
            if (table !== 'sync_op_ledger') return { data: [], error: null };
            const scoped = ledger.filter(
              (row) => row.tenant_id === state.filters.tenant_id && row.facility_id === state.filters.facility_id
            );
            const after = typeof state.gtFilters.seq === 'number' ? state.gtFilters.seq : 0;
            const rows = scoped
              .filter((row) => row.seq > after)
              .slice()
              .sort((a, b) => a.seq - b.seq)
              .slice(0, state.limit);
            return {
              data: rows.map((row) => ({
                seq: row.seq,
                op_id: row.op_id,
                device_id: row.device_id,
                payload: row.payload,
                created_at: row.created_at,
              })),
              error: null,
            };
          };

          return Promise.resolve(execute()).then(onFulfilled, onRejected);
        },
      };
      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter);

    const response = await request(app)
      .get('/api/sync/pull')
      .query({ cursor: '0', limit: '2', facilityId })
      .set('authorization', 'Bearer valid-token');

    assert.equal(response.status, 200);
    assert.equal(response.body.cursor, '2');
    assert.equal(response.body.hasMore, false);
    assert.equal(response.body.ops.length, 2);
    assert.equal(response.body.ops[0].seq, 1);
    assert.equal(response.body.ops[1].seq, 2);
    assert.equal(response.body.ops[0].opId, '22222222-2222-4222-8222-222222222222');
    assert.equal(response.body.ops[1].opId, '44444444-4444-4444-8444-444444444444');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});
