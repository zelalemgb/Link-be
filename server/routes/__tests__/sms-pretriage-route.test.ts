import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadRouter = async () => {
  ensureSupabaseEnv();
  const routerModule = await import('../sms');
  const configModule = await import('../../config/supabase');
  return {
    smsRouter: routerModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('sms pretriage list uses authenticated user facility scope', async () => {
  const { smsRouter, supabaseAdmin } = await loadRouter();
  const originalAuthGetUser = (supabaseAdmin as any).auth.getUser;
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).auth.getUser = async () => ({
      data: {
        user: {
          id: 'auth-user-1',
          email: 'hana.mohammed@goro.sim.linkhc.test',
        },
      },
      error: null,
    });

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'profile-1',
                    tenant_id: 'tenant-1',
                    facility_id: 'facility-goro',
                    user_role: 'receptionist',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'pre_triage_requests') {
        return {
          select: () => ({
            eq: (column: string, value: string) => {
              assert.equal(column, 'facility_id');
              assert.equal(value, 'facility-goro');

              return {
                order: () => ({
                  limit: async () => ({
                    data: [
                      {
                        id: 'pre-1',
                        phone_number: '+251900000001',
                        raw_message: 'Headache and fever',
                        parsed_symptoms: ['headache', 'fever'],
                        recommended_urgency: 'urgent',
                        recommended_cohort: 'adult',
                        ai_summary: 'Urgent review recommended.',
                        status: 'triaged',
                        created_at: '2026-03-13T20:33:44.000Z',
                        linked_visit_id: null,
                      },
                    ],
                    error: null,
                  }),
                }),
              };
            },
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    };

    const app = express();
    app.use(express.json());
    app.use('/api/sms', smsRouter);

    const response = await request(app)
      .get('/api/sms/pretriage?limit=5')
      .set('Authorization', 'Bearer test-token');

    assert.equal(response.status, 200);
    assert.equal(response.body.pretriage.length, 1);
    assert.equal(response.body.pretriage[0].id, 'pre-1');
  } finally {
    (supabaseAdmin as any).auth.getUser = originalAuthGetUser;
    (supabaseAdmin as any).from = originalFrom;
  }
});
