import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

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

test('direct clinic registration POST is exempt from CSRF validation', async () => {
  const { csrfProtection } = await loadModules();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = {};
    next();
  });
  app.use(csrfProtection);
  app.post('/api/auth/register-clinic', async (_req, res) => {
    return res.status(201).json({ success: true });
  });

  const response = await request(app)
    .post('/api/auth/register-clinic')
    .send({
      clinic: {
        name: 'Opian Health Hospital',
        country: 'Ethiopia',
        location: 'Addis Ababa',
        address: 'Bole',
        phoneNumber: '+251911000111',
      },
      admin: {
        name: 'Zelalem Gizachew',
        email: 'zelalem.giz@example.com',
        phoneNumber: '+251922333444',
        password: 'StrongPass#1234',
      },
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
});

test('auth router exposes the direct clinic registration route', () => {
  const authSource = fs.readFileSync(path.resolve('server/routes/auth.ts'), 'utf8');
  assert.match(authSource, /router\.post\('\/register-clinic', async \(req, res\) => \{/);
  assert.match(authSource, /directClinicRegistrationSchema/);
});
