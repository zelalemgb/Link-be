import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

const IDS = {
  tenant: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  facility: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  profile: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  patient: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  visit: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  labOrder: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  doc: '11111111-1111-4111-8111-111111111111',
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const doctorRouteModule = await import('../doctor');
  const configModule = await import('../../config/supabase');
  return {
    doctorRouter: doctorRouteModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('doctor external result upload persists storage file and metadata record', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalStorage = (supabaseAdmin as any).storage;

  const calls: {
    uploadBucket?: string;
    uploadPath?: string;
    uploadContentType?: string;
    insertPayload?: any;
  } = {};

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).storage = {
      from: (bucket: string) => ({
        upload: async (path: string, _buffer: Buffer, options: { contentType?: string }) => {
          calls.uploadBucket = bucket;
          calls.uploadPath = path;
          calls.uploadContentType = options?.contentType;
          return { error: null };
        },
        createSignedUrl: async () => ({
          data: { signedUrl: 'https://signed.example/external-result' },
          error: null,
        }),
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: Record<string, unknown> = {};

      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          state[column] = value;
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'users') {
            return {
              data: {
                id: IDS.profile,
                tenant_id: IDS.tenant,
                facility_id: IDS.facility,
                user_role: 'doctor',
              },
              error: null,
            };
          }

          if (table === 'lab_orders') {
            return {
              data: {
                id: IDS.labOrder,
                visit_id: IDS.visit,
                patient_id: IDS.patient,
                tenant_id: IDS.tenant,
              },
              error: null,
            };
          }

          return { data: null, error: null };
        },
        insert(payload: any) {
          calls.insertPayload = payload;
          return {
            select() {
              return this;
            },
            single: async () => ({
              data: {
                id: IDS.doc,
                order_id: payload.order_id,
                order_type: payload.order_type,
                storage_path: payload.storage_path,
                original_filename: payload.original_filename,
                mime_type: payload.mime_type,
                file_size_bytes: payload.file_size_bytes,
                created_at: '2026-03-10T16:45:00.000Z',
              },
              error: null,
            }),
          };
        },
      };

      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/doctor', doctorRouter);

    const response = await request(app)
      .post('/api/doctor/external-results/upload')
      .set('authorization', 'Bearer valid-token')
      .field('patientId', IDS.patient)
      .field('visitId', IDS.visit)
      .field('orderId', IDS.labOrder)
      .field('itemType', 'lab_test')
      .field('aiExtractedText', 'AI parsed: Hemoglobin 13.2 g/dL')
      .attach('file', Buffer.from('fake-image-content'), {
        filename: 'cbc-report.png',
        contentType: 'image/png',
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.document.id, IDS.doc);
    assert.equal(response.body.document.itemType, 'lab_test');
    assert.equal(response.body.document.fileName, 'cbc-report.png');
    assert.equal(response.body.document.mimeType, 'image/png');
    assert.equal(typeof response.body.document.storagePath, 'string');
    assert.equal(response.body.document.fileUrl, 'https://signed.example/external-result');

    assert.equal(calls.uploadBucket, 'patient-health-records');
    assert.equal(calls.uploadContentType, 'image/png');
    assert.equal(calls.uploadPath?.includes(`external-results/${IDS.tenant}/${IDS.patient}/${IDS.visit}/lab_test/${IDS.labOrder}/`), true);

    assert.equal(calls.insertPayload?.tenant_id, IDS.tenant);
    assert.equal(calls.insertPayload?.facility_id, IDS.facility);
    assert.equal(calls.insertPayload?.patient_id, IDS.patient);
    assert.equal(calls.insertPayload?.visit_id, IDS.visit);
    assert.equal(calls.insertPayload?.order_id, IDS.labOrder);
    assert.equal(calls.insertPayload?.order_type, 'lab_test');
    assert.equal(calls.insertPayload?.ai_extracted_text, 'AI parsed: Hemoglobin 13.2 g/dL');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    (supabaseAdmin as any).storage = originalStorage;
  }
});
