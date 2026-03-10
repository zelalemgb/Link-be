import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const facilitiesModule = await import('../facilities');
  const configModule = await import('../../config/supabase');
  return {
    facilitiesRouter: facilitiesModule.default,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('public facilities directory returns verified records with filters and workspace metadata', async () => {
  const { facilitiesRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    const facilityRows = [
      {
        id: 'fac-1',
        tenant_id: 'tenant-1',
        name: 'Zelalem Hospital',
        location: 'Kirkos',
        address: 'Kirkos, Addis Ababa',
        phone_number: '+251911222333',
        facility_type: 'hospital',
        operating_hours: 'Mon-Sat 7AM-8PM',
        accepts_walk_ins: true,
        verified: true,
      },
      {
        id: 'fac-2',
        tenant_id: 'tenant-2',
        name: 'Rural Link Clinic',
        location: 'Debre Berhan',
        address: 'Main road',
        phone_number: '+251911444555',
        facility_type: 'clinic',
        operating_hours: null,
        accepts_walk_ins: true,
        verified: true,
      },
      {
        id: 'fac-3',
        tenant_id: 'tenant-3',
        name: 'Unverified Center',
        location: 'Bole',
        address: 'Bole, Addis Ababa',
        phone_number: '+251911999999',
        facility_type: 'hospital',
        operating_hours: null,
        accepts_walk_ins: false,
        verified: false,
      },
    ];

    const tenantRows = [
      {
        id: 'tenant-1',
        workspace_type: 'clinic',
        setup_mode: 'recommended',
        team_mode: 'small_team',
        enabled_modules: ['core'],
      },
      {
        id: 'tenant-2',
        workspace_type: 'provider',
        setup_mode: 'recommended',
        team_mode: 'solo',
        enabled_modules: ['core'],
      },
    ];

    (supabaseAdmin as any).from = (table: string) => {
      const state: any = {
        filters: {},
        searchClause: null,
        limitValue: null,
        inFilter: null,
      };

      const query: any = {
        select() {
          return query;
        },
        eq(column: string, value: any) {
          state.filters[column] = value;
          return query;
        },
        order() {
          return query;
        },
        limit(value: number) {
          state.limitValue = value;
          return query;
        },
        or(value: string) {
          state.searchClause = value;
          return query;
        },
        in(column: string, values: string[]) {
          state.inFilter = { column, values };
          return query;
        },
        then(onFulfilled: any, onRejected: any) {
          if (table === 'facilities') {
            let rows = [...facilityRows];

            if (state.filters.verified !== undefined) {
              rows = rows.filter((row) => row.verified === state.filters.verified);
            }
            if (state.filters.facility_type) {
              rows = rows.filter((row) => row.facility_type === state.filters.facility_type);
            }
            if (state.searchClause) {
              const match = String(state.searchClause).match(/name\.ilike\.%(.+?)%/);
              const term = (match?.[1] || '').toLowerCase();
              if (term) {
                rows = rows.filter((row) =>
                  [row.name, row.location, row.address]
                    .map((value) => String(value || '').toLowerCase())
                    .some((value) => value.includes(term))
                );
              }
            }
            if (typeof state.limitValue === 'number') {
              rows = rows.slice(0, state.limitValue);
            }

            return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
          }

          if (table === 'tenants') {
            const tenantIds = state.inFilter?.column === 'id' ? state.inFilter.values || [] : [];
            const rows = tenantRows.filter((tenant) => tenantIds.includes(tenant.id));
            return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
          }

          return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
        },
      };

      return query;
    };

    const app = express();
    app.use(express.json());
    app.use('/api/facilities', facilitiesRouter);

    const response = await request(app).get('/api/facilities/public?search=zelalem&type=hospital&limit=10');

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.facilities.length, 1);
    assert.equal(response.body.facilities[0].name, 'Zelalem Hospital');
    assert.equal(response.body.facilities[0].verified, true);
    assert.equal(response.body.facilities[0].workspace.workspaceType, 'clinic');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
