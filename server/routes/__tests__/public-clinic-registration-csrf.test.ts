import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const { csrfProtection } = await import('../../middleware/csrf');
  const { supabaseAdmin } = await import('../../config/supabase');
  return { csrfProtection, supabaseAdmin: supabaseAdmin as any };
};

test('public clinic registration POST is exempt from CSRF validation', async () => {
  const { csrfProtection, supabaseAdmin } = await loadModules();
  const originalFrom = supabaseAdmin.from;

  try {
    const insertCalls: any[] = [];
    const builder = {
      insert(payload: any) {
        insertCalls.push(payload);
        return this;
      },
      select() {
        return this;
      },
      single: async () => ({
        data: { id: 'registration-1' },
        error: null,
      }),
    };

    supabaseAdmin.from = (table: string) => {
      assert.equal(table, 'clinic_registrations');
      return builder;
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.cookies = {};
      next();
    });
    app.use(csrfProtection);
    app.post('/api/clinics', async (req, res) => {
      const { data, error } = await supabaseAdmin
        .from('clinic_registrations')
        .insert(req.body)
        .select('id')
        .single();

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      return res.status(201).json({ registrationId: data.id });
    });

    const response = await request(app)
      .post('/api/clinics')
      .send({
        clinic: {
          name: 'Selam Clinic',
          country: 'Ethiopia',
          location: 'Addis Ababa',
          address: 'Bole Road',
          phoneNumber: '+251911000111',
          email: 'info@selamclinic.example',
        },
        admin: {
          name: 'Dr Hana',
          email: 'hana@selamclinic.example',
          phoneNumber: '+251922333444',
        },
      });

    assert.equal(response.status, 201);
    assert.equal(response.body.registrationId, 'registration-1');
    assert.equal(insertCalls.length, 1);
  } finally {
    supabaseAdmin.from = originalFrom;
  }
});
