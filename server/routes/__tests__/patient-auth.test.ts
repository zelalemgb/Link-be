import test from 'node:test';
import assert from 'node:assert/strict';
import { requirePatientSession } from '../../middleware/patient-auth';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.PATIENT_SESSION_SECRET = process.env.PATIENT_SESSION_SECRET || 'test-patient-secret';
};

const loadPatientAuthTestables = async () => {
  ensureSupabaseEnv();
  const patientAuthModule = await import('../patient-auth');
  return (patientAuthModule as any).__testables;
};

const createMockResponse = () => {
  const state: { statusCode: number; body: any } = {
    statusCode: 200,
    body: undefined,
  };

  const res: any = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: any) {
      state.body = payload;
      return this;
    },
  };

  return { res, state };
};

test('requirePatientSession returns 401 without token in header or cookie', async () => {
  const req: any = {
    header: () => '',
    cookies: {},
    requestId: 'req-patient-auth-1',
  };
  const { res, state } = createMockResponse();
  let nextCalled = false;

  await requirePatientSession(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 401);
  assert.equal(state.body?.error, 'Missing patient session');
});

test('patient OTP request schema rejects invalid payload', async () => {
  const testables = await loadPatientAuthTestables();
  const result = testables.otpRequestSchema.safeParse({ phoneNumber: '123' });
  assert.equal(result.success, false);
});

test('patient OTP verify schema rejects invalid payload', async () => {
  const testables = await loadPatientAuthTestables();
  const result = testables.otpVerifySchema.safeParse({ phoneNumber: '12345678', otp: '12' });
  assert.equal(result.success, false);
});

test('patient register is blocked unless phone verification (OTP) is satisfied', async () => {
  const testables = await loadPatientAuthTestables();
  const result = testables.patientRegisterSchema.safeParse({
    phoneNumber: '12345678',
    name: 'Test Patient',
    // otp missing => should fail schema parse, enforcing verification precondition
  });
  assert.equal(result.success, false);
});
