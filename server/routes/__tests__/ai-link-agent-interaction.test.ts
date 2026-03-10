import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import axios from 'axios';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

const UUIDS = {
  tenant1: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  facility1: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  profile1: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};

const createFromStub = () => {
  return (table: string) => {
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
      insert() {
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
      single: async () => ({ data: null, error: null }),
    };

    return query;
  };
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const aiRouteModule = await import('../ai');
  const configModule = await import('../../config/supabase');
  return {
    aiRouter: aiRouteModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

const buildApp = (aiRouter: any) => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRouter);
  return app;
};

test('link agent interaction route requires authentication', async () => {
  const { aiRouter } = await loadModules();
  const app = buildApp(aiRouter);

  const response = await request(app).post('/api/ai/link-agent/interaction').send({
    surface: 'patient',
    intent: 'symptom_assessment',
    payload: { message: 'fever and cough' },
  });

  assert.equal(response.status, 401);
});

test('link agent interaction route returns generated response when local service succeeds', async () => {
  const { aiRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalAxiosPost = (axios as any).post;

  try {
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
            surface: 'patient',
            intent: 'symptom_assessment',
            status: 'generated',
            safeMode: true,
            source: 'local_ai',
          },
          message: 'Link Agent generated symptom guidance.',
          content: {
            response: 'Please visit a clinic today if symptoms worsen.',
            urgency: 'clinic_soon',
            nextSteps: ['Hydrate', 'Seek care if fever persists'],
          },
        },
      };
    };

    const app = buildApp(aiRouter);
    const response = await request(app)
      .post('/api/ai/link-agent/interaction')
      .set('authorization', 'Bearer valid-token')
      .send({
        surface: 'patient',
        intent: 'symptom_assessment',
        payload: { message: 'fever and cough' },
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.agent.model, 'link_agent_v1');
    assert.equal(response.body.agent.status, 'generated');
    assert.equal(typeof response.body.content?.response, 'string');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    (axios as any).post = originalAxiosPost;
  }
});

test('link agent interaction route degrades safely when local service is unavailable', async () => {
  const { aiRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;
  const originalAxiosPost = (axios as any).post;

  try {
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

    const app = buildApp(aiRouter);
    const response = await request(app)
      .post('/api/ai/link-agent/interaction')
      .set('authorization', 'Bearer valid-token')
      .send({
        surface: 'clinician',
        intent: 'clinical_assistant',
        payload: {
          patientData: {
            age: 32,
            gender: 'female',
            chiefComplaint: 'headache',
          },
        },
      });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.agent.status, 'fallback');
    assert.equal(response.body.agent.safeMode, true);
    assert.equal(typeof response.body.message, 'string');
    assert.equal(response.body.content?.analysis?._offline, true);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
    (axios as any).post = originalAxiosPost;
  }
});

test('public link agent route blocks clinician intents without authenticated context', async () => {
  const { aiRouter } = await loadModules();
  const app = buildApp(aiRouter);

  const response = await request(app).post('/api/ai/link-agent/interaction-public').send({
    surface: 'clinician',
    intent: 'clinical_assistant',
    payload: {
      patientData: {
        age: 44,
        gender: 'male',
        chiefComplaint: 'chest pain',
      },
    },
  });

  assert.equal(response.status, 403);
});

