import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.PATIENT_SESSION_SECRET = process.env.PATIENT_SESSION_SECRET || 'test-patient-secret';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const patientPortalModule = await import('../patient-portal');
  const configModule = await import('../../config/supabase');
  return {
    patientPortalRouter: patientPortalModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('patient portal synced records route returns prioritized visit summaries, prescriptions, labs, and referrals', async () => {
  const { patientPortalRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    const patientAccountRow = {
      id: 'patient-account-1',
      phone_number: '+251911000001',
      tenant_id: 'tenant-1',
    };

    const patientRows = [{ id: 'patient-1' }];

    const visitRows = [
      {
        id: 'visit-1',
        visit_date: '2026-03-01',
        created_at: '2026-03-01T08:00:00Z',
        chief_complaint: 'Fever and cough',
        reason: null,
        provider: 'Dr. Hana',
        status: 'completed',
        outcome: 'referred',
        follow_up_date: '2026-03-08',
        visit_notes: null,
        diagnoses_json: [{ display_name: 'Community acquired pneumonia' }],
        referral_json: {
          is_referred: true,
          destination: 'Regional Hospital',
          urgency: 'urgent',
          reason: 'Needs advanced imaging',
        },
      },
      {
        id: 'visit-2',
        visit_date: '2026-02-20',
        created_at: '2026-02-20T10:00:00Z',
        chief_complaint: 'Headache',
        reason: null,
        provider: 'Dr. Kebede',
        status: 'completed',
        outcome: 'discharged',
        follow_up_date: null,
        visit_notes: null,
        diagnoses_json: [],
        referral_json: null,
      },
    ];

    const medicationRows = [
      {
        id: 'med-1',
        visit_id: 'visit-1',
        medication_name: 'Amoxicillin',
        dosage: '500mg',
        frequency: 'TID',
        duration: '7 days',
        route: 'oral',
        status: 'dispensed',
        ordered_at: '2026-03-01T09:00:00Z',
        dispensed_at: '2026-03-01T10:00:00Z',
      },
    ];

    const labRows = [
      {
        id: 'lab-1',
        visit_id: 'visit-1',
        test_name: 'CBC',
        status: 'completed',
        result: 'Mild leukocytosis',
        result_value: 'WBC 12.2',
        reference_range: '4.0-11.0',
        ordered_at: '2026-03-01T09:30:00Z',
        completed_at: '2026-03-01T11:00:00Z',
      },
      {
        id: 'lab-2',
        visit_id: 'visit-2',
        test_name: 'CRP',
        status: 'pending',
        result: null,
        result_value: null,
        reference_range: null,
        ordered_at: '2026-02-20T11:30:00Z',
        completed_at: null,
      },
    ];

    (supabaseAdmin as any).from = (table: string) => {
      const state: any = {
        operation: 'select',
        filters: {},
        inFilters: {},
      };

      const query: any = {
        select() {
          state.operation = 'select';
          return query;
        },
        insert() {
          state.operation = 'insert';
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
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'patient_accounts') {
            return { data: patientAccountRow, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => ({ data: null, error: null }),
        then(onFulfilled: any, onRejected: any) {
          if (table === 'patients') {
            return Promise.resolve({ data: patientRows, error: null }).then(onFulfilled, onRejected);
          }
          if (table === 'visits') {
            return Promise.resolve({ data: visitRows, error: null }).then(onFulfilled, onRejected);
          }
          if (table === 'medication_orders') {
            return Promise.resolve({ data: medicationRows, error: null }).then(onFulfilled, onRejected);
          }
          if (table === 'lab_orders') {
            return Promise.resolve({ data: labRows, error: null }).then(onFulfilled, onRejected);
          }
          if (table === 'audit_log') {
            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        },
      };

      return query;
    };

    const token = jwt.sign(
      {
        patientId: 'patient-account-1',
        phoneNumber: '+251911000001',
      },
      process.env.PATIENT_SESSION_SECRET!
    );

    const app = express();
    app.use(express.json());
    app.use('/api/patient-portal', patientPortalRouter);

    const response = await request(app)
      .get('/api/patient-portal/records/synced?limit=25')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.records.length, 5);
    assert.equal(response.body.records[0].document_type, 'visit_summary');
    assert.equal(
      response.body.records.some((record: any) => record.document_type === 'prescription'),
      true
    );
    assert.equal(
      response.body.records.some((record: any) => record.document_type === 'lab_result'),
      true
    );
    assert.equal(
      response.body.records.some((record: any) => record.document_type === 'referral_summary'),
      true
    );
    assert.deepEqual(response.body.counts, {
      visitSummaries: 2,
      prescriptions: 1,
      labResults: 1,
      referralSummaries: 1,
    });
    assert.equal(typeof response.body.growth?.facilityFinderUrl, 'string');
    assert.equal(typeof response.body.growth?.patientAppInstallUrl, 'string');
    assert.equal(typeof response.body.records[0]?.continuity_url, 'string');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
