import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.PATIENT_SESSION_SECRET = process.env.PATIENT_SESSION_SECRET || 'test-patient-secret';
  process.env.PATIENT_OTP_PEPPER = '';
  process.env.PATIENT_DEFAULT_TENANT_ID =
    process.env.PATIENT_DEFAULT_TENANT_ID || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
};

const hashOtp = (otp: string) => {
  const pepper = process.env.PATIENT_OTP_PEPPER || '';
  return crypto.createHash('sha256').update(`${otp}:${pepper}`).digest('hex');
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const patientAuthModule = await import('../patient-auth');
  const configModule = await import('../../config/supabase');
  return {
    patientAuthRouter: patientAuthModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('patient register is blocked unless durable phone verification state exists', async () => {
  const { patientAuthRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  let patientInsertCalls = 0;

  try {
    const otpRow = {
      id: 'otp-1',
      code_hash: hashOtp('123456'),
      attempts: 0,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: any = { operation: 'select', filters: {}, payload: null };
      const query: any = {
        select() {
          state.operation = 'select';
          return query;
        },
        insert(payload: any) {
          state.operation = 'insert';
          state.payload = payload;
          if (table === 'patient_accounts') patientInsertCalls += 1;
          return query;
        },
        update(payload: any) {
          state.operation = 'update';
          state.payload = payload;
          return query;
        },
        delete() {
          state.operation = 'delete';
          return query;
        },
        upsert(payload: any) {
          state.operation = 'upsert';
          state.payload = payload;
          return query;
        },
        eq(column: string, value: any) {
          state.filters[column] = value;
          return query;
        },
        gt() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'patient_auth_otps') return { data: otpRow, error: null };
          if (table === 'patient_accounts') return { data: null, error: null };
          if (table === 'patient_portal_phone_verifications') return { data: null, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: null, error: null }),
        then: (onFulfilled: any, onRejected: any) =>
          Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
      };
      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/patient-auth', patientAuthRouter);

    const response = await request(app).post('/api/patient-auth/register').send({
      phoneNumber: '+251 911 111 111',
      otp: '123456',
      name: 'Test Patient',
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'PERM_PHONE_VERIFICATION_REQUIRED');
    assert.equal(response.body.error, 'phone_verification_required');
    assert.equal(patientInsertCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('verify-otp persists durable verification state even when patient account is missing (new registration flow)', async () => {
  const { patientAuthRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  let verificationUpsertPayload: any = null;

  try {
    const otpRow = {
      id: 'otp-1',
      code_hash: hashOtp('123456'),
      attempts: 0,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };

    (supabaseAdmin as any).from = (table: string) => {
      const state: any = { operation: 'select', filters: {}, payload: null };
      const query: any = {
        select() {
          state.operation = 'select';
          return query;
        },
        insert(payload: any) {
          state.operation = 'insert';
          state.payload = payload;
          return query;
        },
        update(payload: any) {
          state.operation = 'update';
          state.payload = payload;
          return query;
        },
        delete() {
          state.operation = 'delete';
          return query;
        },
        upsert(payload: any) {
          state.operation = 'upsert';
          state.payload = payload;
          return query;
        },
        eq(column: string, value: any) {
          state.filters[column] = value;
          return query;
        },
        gt() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          if (table === 'patient_auth_otps') return { data: otpRow, error: null };
          if (table === 'patient_accounts') return { data: null, error: null };
          if (table === 'tenants') return { data: { id: process.env.PATIENT_DEFAULT_TENANT_ID }, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: null, error: null }),
        then: (onFulfilled: any, onRejected: any) => {
          if (table === 'patient_portal_phone_verifications' && state.operation === 'upsert') {
            verificationUpsertPayload = state.payload;
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        },
      };
      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/patient-auth', patientAuthRouter);

    const response = await request(app).post('/api/patient-auth/verify-otp').send({
      phoneNumber: '+251 911 111 111',
      otp: '123456',
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'patient_not_found');
    assert.ok(verificationUpsertPayload, 'Expected phone verification upsert on successful OTP verify');
    assert.equal(verificationUpsertPayload.phone_number, '+251911111111');
    assert.equal(verificationUpsertPayload.is_verified, true);
    assert.equal(verificationUpsertPayload.tenant_id, process.env.PATIENT_DEFAULT_TENANT_ID);
    assert.ok(verificationUpsertPayload.verified_at);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

