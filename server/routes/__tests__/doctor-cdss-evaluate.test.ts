import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import axios from 'axios';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
  process.env.CDSS_AI_ADVISORY_ENABLED = 'false';
};

const UUIDS = {
  tenant1: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  facility1: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  profile1: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};

type QueryState = {
  operation: 'select' | 'update' | 'insert';
  filters: Record<string, unknown>;
  payload?: any;
};

const createFromStub = () => {
  return (table: string) => {
    const state: QueryState = {
      operation: 'select',
      filters: {},
    };

    const query: any = {
      select() {
        return query;
      },
      eq(column: string, value: unknown) {
        state.filters[column] = value;
        return query;
      },
      limit() {
        return query;
      },
      maybeSingle: async () => {
        if (table === 'users') {
          return {
            data: {
              id: UUIDS.profile1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              user_role: 'doctor',
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    };

    return query;
  };
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

const buildApp = (doctorRouter: any) => {
  const app = express();
  app.use(express.json());
  app.use('/api/doctor', doctorRouter);
  return app;
};

const validPayload = () => ({
  checkpoint: 'consult',
  patient: {
    ageYears: 34,
    sex: 'male',
    pregnant: false,
  },
  vitals: {
    temperature: 37.2,
    bloodPressure: '120/80',
    heartRate: 86,
    respiratoryRate: 18,
    oxygenSaturation: 98,
    weightKg: 70,
  },
  symptoms: ['headache'],
  chiefComplaint: 'Headache',
  diagnosis: 'Tension headache',
  pendingOrders: [],
  acknowledgeOutstandingOrders: false,
  includeAiAdvisory: false,
});

test('doctor CDSS evaluate route requires authentication', async () => {
  const { doctorRouter } = await loadModules();
  const app = buildApp(doctorRouter);

  const response = await request(app)
    .post('/api/doctor/cdss/evaluate')
    .send(validPayload());

  assert.equal(response.status, 401);
});

test('doctor CDSS evaluate returns hard stop for critical oxygen saturation', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };
    (supabaseAdmin as any).from = createFromStub();

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post('/api/doctor/cdss/evaluate')
      .set('authorization', 'Bearer valid-token')
      .send({
        ...validPayload(),
        vitals: {
          ...validPayload().vitals,
          oxygenSaturation: 88,
        },
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(
      response.body.hardStops.some((item: any) => item.code === 'CDSS_HARD_OXYGEN_SAT_CRITICAL'),
      true
    );
    assert.equal(response.body.referral.required, true);
    assert.equal(response.body.referral.urgency, 'emergency');
    assert.equal(typeof response.body.briefSummary?.text, 'string');
    assert.equal(
      response.body.briefSummary?.guidelineBasis?.includes('Ethiopian Primary Health Care Clinical Guideline'),
      true
    );
    assert.equal(response.body.aiAdvisory.status, 'skipped');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor CDSS evaluate returns maternal severe hypertension hard stop', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };
    (supabaseAdmin as any).from = createFromStub();

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post('/api/doctor/cdss/evaluate')
      .set('authorization', 'Bearer valid-token')
      .send({
        ...validPayload(),
        checkpoint: 'admit',
        patient: {
          ageYears: 27,
          sex: 'female',
          pregnant: true,
        },
        vitals: {
          ...validPayload().vitals,
          bloodPressure: '170/112',
        },
        symptoms: ['severe headache', 'blurred vision'],
      });

    assert.equal(response.status, 200);
    assert.equal(
      response.body.hardStops.some(
        (item: any) => item.code === 'CDSS_HARD_MATERNAL_SEVERE_HYPERTENSION'
      ),
      true
    );
    assert.equal(response.body.cohort, 'maternal');
    assert.equal(
      response.body.briefSummary?.guidelineBasis?.includes('WHO Emergency and Referral Red-Flag Guidance'),
      true
    );
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor CDSS evaluate blocks discharge when pending orders are not acknowledged', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };
    (supabaseAdmin as any).from = createFromStub();

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post('/api/doctor/cdss/evaluate')
      .set('authorization', 'Bearer valid-token')
      .send({
        ...validPayload(),
        checkpoint: 'discharge',
        diagnosis: 'Community acquired pneumonia',
        pendingOrders: ['Lab: CBC (pending)'],
        acknowledgeOutstandingOrders: false,
      });

    assert.equal(response.status, 200);
    assert.equal(
      response.body.hardStops.some(
        (item: any) => item.code === 'CDSS_HARD_PENDING_ORDERS_ACK_REQUIRED'
      ),
      true
    );
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor CDSS evaluate generates advisory via Link Agent interaction when enabled', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalAxiosPost = (axios as any).post;
  const previousFlag = process.env.CDSS_AI_ADVISORY_ENABLED;

  try {
    process.env.CDSS_AI_ADVISORY_ENABLED = 'true';

    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };
    (supabaseAdmin as any).from = createFromStub();
    (axios as any).post = async (url: string) => {
      assert.match(url, /\/link-agent\/respond$/);
      return {
        data: {
          success: true,
          agent: {
            model: 'link_agent_v1',
            surface: 'clinician',
            intent: 'clinical_assistant',
            status: 'generated',
            safeMode: true,
            source: 'local_ai',
          },
          message: 'Link Agent generated clinician support.',
          content: {
            success: true,
            analysis: {
              differentialDiagnosis: [
                {
                  diagnosis: 'Community acquired pneumonia',
                  probability: 'High',
                },
              ],
            },
          },
        },
      };
    };

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post('/api/doctor/cdss/evaluate')
      .set('authorization', 'Bearer valid-token')
      .send({
        ...validPayload(),
        includeAiAdvisory: true,
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.aiAdvisory.enabled, true);
    assert.equal(response.body.aiAdvisory.status, 'generated');
    assert.match(response.body.aiAdvisory.summary, /Community acquired pneumonia/);
    assert.equal(response.body.aiAdvisory.model, 'link_agent_v1');
  } finally {
    process.env.CDSS_AI_ADVISORY_ENABLED = previousFlag || 'false';
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    (axios as any).post = originalAxiosPost;
  }
});

test('doctor CDSS evaluate marks advisory unavailable when Link Agent falls back', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalAxiosPost = (axios as any).post;
  const previousFlag = process.env.CDSS_AI_ADVISORY_ENABLED;

  try {
    process.env.CDSS_AI_ADVISORY_ENABLED = 'true';

    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };
    (supabaseAdmin as any).from = createFromStub();
    (axios as any).post = async () => {
      throw new Error('local ai unavailable');
    };

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post('/api/doctor/cdss/evaluate')
      .set('authorization', 'Bearer valid-token')
      .send({
        ...validPayload(),
        includeAiAdvisory: true,
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.aiAdvisory.enabled, true);
    assert.equal(response.body.aiAdvisory.status, 'unavailable');
    assert.match(
      response.body.aiAdvisory.error,
      /(Link Agent is offline|AI advisory unavailable)/i
    );
  } finally {
    process.env.CDSS_AI_ADVISORY_ENABLED = previousFlag || 'false';
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    (axios as any).post = originalAxiosPost;
  }
});
