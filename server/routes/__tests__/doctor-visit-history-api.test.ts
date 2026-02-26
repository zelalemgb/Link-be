import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

const UUIDS = {
  tenant1: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenant2: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  facility1: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  visit1: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  profile1: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  profile2: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  patient1: '11111111-1111-4111-8111-111111111111',
};

type QueryState = {
  operation: 'select' | 'update' | 'insert';
  filters: Record<string, unknown>;
  payload?: any;
};

type TableHandler = {
  maybeSingle?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
  insert?: (payload: any, state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
};

const createFromStub = (handlers: Record<string, TableHandler>) => {
  return (table: string) => {
    const state: QueryState = {
      operation: 'select',
      filters: {},
    };
    const handler = handlers[table] || {};

    const query: any = {
      select() {
        if (state.operation === 'select') {
          state.operation = 'select';
        }
        return query;
      },
      update(payload: any) {
        state.operation = 'update';
        state.payload = payload;
        return query;
      },
      insert(payload: any) {
        state.operation = 'insert';
        state.payload = payload;
        if (handler.insert) {
          return handler.insert(payload, state);
        }
        return Promise.resolve({ data: null, error: null });
      },
      eq(column: string, value: unknown) {
        state.filters[column] = value;
        return query;
      },
      limit() {
        return query;
      },
      maybeSingle: async () => (handler.maybeSingle ? handler.maybeSingle(state) : { data: null, error: null }),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
    };

    return query;
  };
};

const buildValidPayload = () => ({
  chiefComplaints: [
    {
      id: '1',
      complaint: 'Cough',
      hpi: {
        onset: 'gradual',
        duration: '2 days',
        pattern: 'worsening',
        associatedSymptoms: ['fever'],
        aggravatingFactors: '',
        relievingFactors: '',
      },
    },
  ],
  medicalHistory: {
    diabetes: false,
    hypertension: false,
    priorSurgery: false,
    medications: 'None',
    allergies: 'NKDA',
    smoking: 'never',
    alcohol: 'never',
    familyHistory: '',
  },
  reviewOfSystems: {
    general: { checked: false, findings: '' },
    respiratory: { checked: true, findings: 'Dry cough' },
    cardiovascular: { checked: false, findings: '' },
    gastrointestinal: { checked: false, findings: '' },
    genitourinary: { checked: false, findings: '' },
    neurological: { checked: false, findings: '' },
    musculoskeletal: { checked: false, findings: '' },
  },
  clinicalNotes: {
    observations: 'No red flags',
  },
  pregnancyFlag: false,
});

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

test('doctor visit history save succeeds for assigned provider in tenant/facility scope', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  let capturedVisitUpdate: any = null;
  let capturedUpdateFilters: Record<string, unknown> | null = null;
  const capturedAuditEvents: any[] = [];

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.profile1,
            tenant_id: UUIDS.tenant1,
            facility_id: UUIDS.facility1,
            user_role: 'doctor',
          },
          error: null,
        }),
      },
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            capturedVisitUpdate = state.payload;
            capturedUpdateFilters = state.filters;
            return {
              data: { id: UUIDS.visit1 },
              error: null,
            };
          }

          return {
            data: {
              id: UUIDS.visit1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              assigned_doctor: UUIDS.profile1,
              patient_id: UUIDS.patient1,
              status: 'with_doctor',
              visit_notes: JSON.stringify({ existing: true }),
              weight: 68,
              blood_pressure: '120/80',
            },
            error: null,
          };
        },
      },
      patients: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.patient1,
            age: 32,
            gender: 'male',
            date_of_birth: null,
          },
          error: null,
        }),
      },
      audit_log: {
        insert: (payload) => {
          capturedAuditEvents.push(payload);
          return { data: null, error: null };
        },
      },
      outbox_events: {
        insert: () => ({ data: null, error: null }),
      },
    });

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(buildValidPayload());

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.ok(Array.isArray(response.body.warnings));
    const warningCodes = new Set((response.body.warnings || []).map((warning: any) => warning.code));
    assert.equal(warningCodes.has('WARNING_DH_SW_002_FAMILY_HISTORY_EMPTY'), true);
    assert.equal(warningCodes.has('WARNING_DH_SW_004_FOLLOW_UP_MISSING'), true);

    assert.ok(capturedVisitUpdate, 'Expected visit update payload');
    assert.equal(capturedUpdateFilters?.id, UUIDS.visit1);
    assert.equal(capturedUpdateFilters?.facility_id, UUIDS.facility1);
    assert.equal(capturedUpdateFilters?.tenant_id, UUIDS.tenant1);

    const persistedNotes = JSON.parse(capturedVisitUpdate.visit_notes);
    assert.equal(persistedNotes.structuredAssessment.chiefComplaints[0].complaint, 'Cough');
    assert.equal(persistedNotes.structuredAssessment.medicalHistory.allergies, 'NKDA');
    assert.equal(persistedNotes.structuredAssessment.reviewOfSystems.respiratory.checked, true);
    assert.equal(capturedAuditEvents.length, 1);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces unauthorized and forbidden outcomes', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  let visitTableCalls = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'visits') {
        visitTableCalls += 1;
      }

      return createFromStub({
        users: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.profile1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              user_role: 'nurse',
            },
            error: null,
          }),
        },
        audit_log: {
          insert: () => ({ data: null, error: null }),
        },
        outbox_events: {
          insert: () => ({ data: null, error: null }),
        },
      })(table);
    };

    const app = buildApp(doctorRouter);

    const unauthorized = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .send(buildValidPayload());
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error, 'Missing bearer token');

    const forbidden = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(buildValidPayload());
    assert.equal(forbidden.status, 403);
    assert.deepEqual(forbidden.body, {
      code: 'PERM_VISIT_HISTORY_SAVE_FORBIDDEN',
      message: 'Role nurse cannot save visit history',
    });
    assert.equal(visitTableCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route rejects cross-tenant attempts', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  let updateCalls = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.profile1,
            tenant_id: UUIDS.tenant1,
            facility_id: UUIDS.facility1,
            user_role: 'doctor',
          },
          error: null,
        }),
      },
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            updateCalls += 1;
            return { data: { id: UUIDS.visit1 }, error: null };
          }
          return {
            data: {
              id: UUIDS.visit1,
              tenant_id: UUIDS.tenant2,
              facility_id: UUIDS.facility1,
              assigned_doctor: UUIDS.profile1,
              patient_id: UUIDS.patient1,
              status: 'with_doctor',
              visit_notes: null,
            },
            error: null,
          };
        },
      },
      audit_log: {
        insert: () => ({ data: null, error: null }),
      },
      outbox_events: {
        insert: () => ({ data: null, error: null }),
      },
    });

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(buildValidPayload());

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      code: 'TENANT_RESOURCE_SCOPE_VIOLATION',
      message: 'Visit is outside your tenant scope',
    });
    assert.equal(updateCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces assigned-provider authorization', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  let updateCalls = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.profile1,
            tenant_id: UUIDS.tenant1,
            facility_id: UUIDS.facility1,
            user_role: 'doctor',
          },
          error: null,
        }),
      },
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            updateCalls += 1;
            return { data: { id: UUIDS.visit1 }, error: null };
          }
          return {
            data: {
              id: UUIDS.visit1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              assigned_doctor: UUIDS.profile2,
              patient_id: UUIDS.patient1,
              status: 'with_doctor',
              visit_notes: null,
            },
            error: null,
          };
        },
      },
      audit_log: {
        insert: () => ({ data: null, error: null }),
      },
      outbox_events: {
        insert: () => ({ data: null, error: null }),
      },
    });

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(buildValidPayload());

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      code: 'PERM_VISIT_HISTORY_SAVE_FORBIDDEN',
      message: 'Visit is not assigned to the authenticated provider',
    });
    assert.equal(updateCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route rejects malformed payload contract', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  let visitTableCalls = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'visits') {
        visitTableCalls += 1;
      }
      return createFromStub({
        users: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.profile1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              user_role: 'doctor',
            },
            error: null,
          }),
        },
      })(table);
    };

    const app = buildApp(doctorRouter);
    const invalidPayload: any = buildValidPayload();
    invalidPayload.reviewOfSystems.general.checked = 'yes';

    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(invalidPayload);

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'VALIDATION_INVALID_DOCTOR_HISTORY_PAYLOAD');
    assert.equal(visitTableCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route maps schema-level required-field failures to stable HS code/message outcomes', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  let visitTableCalls = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'visits') {
        visitTableCalls += 1;
      }
      return createFromStub({
        users: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.profile1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              user_role: 'doctor',
            },
            error: null,
          }),
        },
      })(table);
    };

    const app = buildApp(doctorRouter);
    const cases = [
      {
        mutate: (payload: any) => {
          delete payload.chiefComplaints[0].complaint;
        },
        expected: {
          code: 'VALIDATION_DH_HS_001_MISSING_CHIEF_COMPLAINT',
          message: 'Chief complaint is required before you can continue.',
        },
      },
      {
        mutate: (payload: any) => {
          delete payload.chiefComplaints[0].hpi.duration;
        },
        expected: {
          code: 'VALIDATION_DH_HS_002_MISSING_HPI_DURATION',
          message: 'History duration is required before you can continue.',
        },
      },
      {
        mutate: (payload: any) => {
          delete payload.chiefComplaints[0].hpi.associatedSymptoms;
        },
        expected: {
          code: 'VALIDATION_DH_HS_003_MISSING_ASSOCIATED_SYMPTOM',
          message: 'At least one associated symptom is required.',
        },
      },
      {
        mutate: (payload: any) => {
          delete payload.medicalHistory.allergies;
        },
        expected: {
          code: 'VALIDATION_DH_HS_004_MISSING_ALLERGY_STATUS',
          message: "Allergy status is required. Enter known allergies or 'None/NKDA'.",
        },
      },
      {
        mutate: (payload: any) => {
          delete payload.medicalHistory.medications;
        },
        expected: {
          code: 'VALIDATION_DH_HS_005_MISSING_MEDICATION_HISTORY',
          message: "Current medication history is required. Enter active medications or 'None'.",
        },
      },
    ];

    for (const testCase of cases) {
      const payload: any = buildValidPayload();
      testCase.mutate(payload);

      const response = await request(app)
        .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
        .set('authorization', 'Bearer valid-token')
        .send(payload);

      assert.equal(response.status, 400);
      assert.deepEqual(response.body, testCase.expected);
    }

    assert.equal(visitTableCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces pediatric required fields with stable code/message', async () => {
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

    const createAppWithVisit = (visitOverrides: Record<string, unknown> = {}) => {
      (supabaseAdmin as any).from = createFromStub({
        users: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.profile1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              user_role: 'doctor',
            },
            error: null,
          }),
        },
        visits: {
          maybeSingle: (state) => {
            if (state.operation === 'update') {
              return { data: { id: UUIDS.visit1 }, error: null };
            }
            return {
              data: {
                id: UUIDS.visit1,
                tenant_id: UUIDS.tenant1,
                facility_id: UUIDS.facility1,
                assigned_doctor: UUIDS.profile1,
                patient_id: UUIDS.patient1,
                status: 'with_doctor',
                visit_notes: null,
                weight: 20,
                blood_pressure: '100/70',
                ...visitOverrides,
              },
              error: null,
            };
          },
        },
        patients: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.patient1,
              age: 8,
              gender: 'male',
              date_of_birth: null,
            },
            error: null,
          }),
        },
      });

      return buildApp(doctorRouter);
    };

    const pediatricMissingWeightApp = createAppWithVisit({ weight: null });
    const missingWeightResponse = await request(pediatricMissingWeightApp)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(buildValidPayload());

    assert.equal(missingWeightResponse.status, 400);
    assert.deepEqual(missingWeightResponse.body, {
      code: 'VALIDATION_DH_HS_007_PEDIATRIC_WEIGHT_REQUIRED',
      message: 'Patient weight is required for pediatric safety checks before continuing.',
    });

    const pediatricMissingFollowUpApp = createAppWithVisit({ weight: 19.5 });
    const missingFollowUpPayload: any = buildValidPayload();
    missingFollowUpPayload.clinicalNotes = {
      observations: 'Stable child',
      nextSteps: '',
    };
    const missingFollowUpResponse = await request(pediatricMissingFollowUpApp)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(missingFollowUpPayload);

    assert.equal(missingFollowUpResponse.status, 400);
    assert.deepEqual(missingFollowUpResponse.body, {
      code: 'VALIDATION_DH_PEDIATRIC_FOLLOW_UP_REQUIRED',
      message: 'Follow-up plan is required for pediatric safety before continuing.',
    });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces maternal required fields with stable code/message', async () => {
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

    const createAppWithVisit = (visitOverrides: Record<string, unknown> = {}) => {
      (supabaseAdmin as any).from = createFromStub({
        users: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.profile1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              user_role: 'doctor',
            },
            error: null,
          }),
        },
        visits: {
          maybeSingle: (state) => {
            if (state.operation === 'update') {
              return { data: { id: UUIDS.visit1 }, error: null };
            }
            return {
              data: {
                id: UUIDS.visit1,
                tenant_id: UUIDS.tenant1,
                facility_id: UUIDS.facility1,
                assigned_doctor: UUIDS.profile1,
                patient_id: UUIDS.patient1,
                status: 'with_doctor',
                visit_notes: null,
                weight: 58,
                blood_pressure: '110/70',
                ...visitOverrides,
              },
              error: null,
            };
          },
        },
        patients: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.patient1,
              age: 26,
              gender: 'female',
              date_of_birth: null,
            },
            error: null,
          }),
        },
      });

      return buildApp(doctorRouter);
    };

    const baseMaternalPayload: any = buildValidPayload();
    baseMaternalPayload.pregnancyFlag = true;

    const maternalMissingBpApp = createAppWithVisit({ blood_pressure: null });
    const missingBpResponse = await request(maternalMissingBpApp)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(baseMaternalPayload);

    assert.equal(missingBpResponse.status, 400);
    assert.deepEqual(missingBpResponse.body, {
      code: 'VALIDATION_DH_HS_008_MATERNAL_BP_REQUIRED',
      message: 'Blood pressure is required for maternal safety before continuing.',
    });

    const maternalMissingObsContextApp = createAppWithVisit();
    const missingObsContextPayload: any = buildValidPayload();
    missingObsContextPayload.pregnancyFlag = true;
    missingObsContextPayload.clinicalNotes = {
      observations: 'Pregnancy follow-up reviewed.',
      nextSteps: 'Continue ANC care.',
    };
    const missingObsContextResponse = await request(maternalMissingObsContextApp)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(missingObsContextPayload);

    assert.equal(missingObsContextResponse.status, 400);
    assert.deepEqual(missingObsContextResponse.body, {
      code: 'VALIDATION_DH_HS_009_MATERNAL_OBSTETRIC_CONTEXT_REQUIRED',
      message: 'Maternal obstetric context is required in clinical observations (LMP/GA/weeks/trimester).',
    });

    const maternalMissingDangerSignApp = createAppWithVisit();
    const missingDangerSignPayload: any = buildValidPayload();
    missingDangerSignPayload.pregnancyFlag = true;
    missingDangerSignPayload.clinicalNotes = {
      observations: 'LMP 2 weeks ago; GA estimate documented.',
      nextSteps: 'Continue ANC follow-up next week.',
    };
    const missingDangerSignResponse = await request(maternalMissingDangerSignApp)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(missingDangerSignPayload);

    assert.equal(missingDangerSignResponse.status, 400);
    assert.deepEqual(missingDangerSignResponse.body, {
      code: 'VALIDATION_DH_MATERNAL_DANGER_SIGN_SCREEN_REQUIRED',
      message:
        'Maternal danger-sign screen documentation is required in observations or next steps before continuing.',
    });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces HS-006 diagnosis requirement for terminal actions', async () => {
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

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.profile1,
            tenant_id: UUIDS.tenant1,
            facility_id: UUIDS.facility1,
            user_role: 'doctor',
          },
          error: null,
        }),
      },
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            return { data: { id: UUIDS.visit1 }, error: null };
          }
          return {
            data: {
              id: UUIDS.visit1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              assigned_doctor: UUIDS.profile1,
              patient_id: UUIDS.patient1,
              status: 'with_doctor',
              visit_notes: null,
              weight: 65,
              blood_pressure: '120/80',
            },
            error: null,
          };
        },
      },
      patients: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.patient1,
            age: 30,
            gender: 'male',
            date_of_birth: null,
          },
          error: null,
        }),
      },
    });

    const payload: any = buildValidPayload();
    payload.action = 'complete';
    payload.followUp = '3 days';
    payload.medicalHistory.familyHistory = 'No known family history';
    payload.clinicalNotes = {
      observations: 'Stable patient',
      nextSteps: 'Follow-up after treatment.',
    };

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(payload);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      code: 'VALIDATION_DH_HS_006_DIAGNOSIS_REQUIRED_FOR_CLOSURE',
      message: 'Diagnosis is required before completing, discharging, or admitting this visit.',
    });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces HS-010 emergency override completeness', async () => {
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

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.profile1,
            tenant_id: UUIDS.tenant1,
            facility_id: UUIDS.facility1,
            user_role: 'doctor',
          },
          error: null,
        }),
      },
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            return { data: { id: UUIDS.visit1 }, error: null };
          }
          return {
            data: {
              id: UUIDS.visit1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              assigned_doctor: UUIDS.profile1,
              patient_id: UUIDS.patient1,
              status: 'with_doctor',
              visit_notes: null,
              weight: 65,
              blood_pressure: '120/80',
            },
            error: null,
          };
        },
      },
      patients: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.patient1,
            age: 30,
            gender: 'male',
            date_of_birth: null,
          },
          error: null,
        }),
      },
    });

    const payload: any = buildValidPayload();
    payload.action = 'admit';
    payload.followUp = '2 days';
    payload.medicalHistory.familyHistory = 'No known family history';
    payload.clinicalNotes = {
      observations: 'Stable patient',
      diagnosis: 'Acute respiratory infection',
      nextSteps: 'Admit for monitoring',
    };
    payload.emergencyException = {
      applied: true,
      reason: 'short',
      immediateAction: 'short',
      missingFieldRuleIds: [],
      recordedAt: 'not-a-date',
      recordedBy: '',
    };

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(payload);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      code: 'VALIDATION_DH_HS_010_EMERGENCY_OVERRIDE_REQUIRED',
      message: 'Emergency exception is incomplete. Add reason, immediate action, and missing-field list.',
    });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route returns SW-001..SW-004 warnings with stable contract payload', async () => {
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

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.profile1,
            tenant_id: UUIDS.tenant1,
            facility_id: UUIDS.facility1,
            user_role: 'doctor',
          },
          error: null,
        }),
      },
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            return { data: { id: UUIDS.visit1 }, error: null };
          }
          return {
            data: {
              id: UUIDS.visit1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              assigned_doctor: UUIDS.profile1,
              patient_id: UUIDS.patient1,
              status: 'with_doctor',
              visit_notes: null,
              weight: 65,
              blood_pressure: '120/80',
            },
            error: null,
          };
        },
      },
      patients: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.patient1,
            age: 30,
            gender: 'male',
            date_of_birth: null,
          },
          error: null,
        }),
      },
      audit_log: {
        insert: () => ({ data: null, error: null }),
      },
      outbox_events: {
        insert: () => ({ data: null, error: null }),
      },
    });

    const payload: any = buildValidPayload();
    payload.action = 'save';
    payload.medicalHistory.familyHistory = '';
    payload.medicalHistory.smoking = '';
    payload.medicalHistory.alcohol = '';
    payload.reviewOfSystems = {
      general: { checked: false, findings: '' },
      respiratory: { checked: false, findings: '' },
      cardiovascular: { checked: false, findings: '' },
      gastrointestinal: { checked: false, findings: '' },
      genitourinary: { checked: false, findings: '' },
      neurological: { checked: false, findings: '' },
      musculoskeletal: { checked: false, findings: '' },
    };
    payload.clinicalNotes = {
      observations: 'Stable patient',
      nextSteps: '',
    };
    payload.followUp = '';

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(payload);

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.ok(Array.isArray(response.body.warnings));

    const warnings = response.body.warnings as Array<Record<string, any>>;
    const warningCodes = new Set(warnings.map((warning) => warning.code));
    assert.equal(warningCodes.has('WARNING_DH_SW_001_ROS_EMPTY'), true);
    assert.equal(warningCodes.has('WARNING_DH_SW_002_FAMILY_HISTORY_EMPTY'), true);
    assert.equal(warningCodes.has('WARNING_DH_SW_003_SOCIAL_HISTORY_INCOMPLETE'), true);
    assert.equal(warningCodes.has('WARNING_DH_SW_004_FOLLOW_UP_MISSING'), true);

    warnings.forEach((warning) => {
      assert.equal(warning.severity, 'warning');
      assert.equal(warning.ackRequired, true);
      assert.ok(Array.isArray(warning.fieldKeys));
      assert.ok(typeof warning.ruleId === 'string');
      assert.ok(typeof warning.message === 'string');
    });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces terminal-action SW-004 block semantics', async () => {
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

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.profile1,
            tenant_id: UUIDS.tenant1,
            facility_id: UUIDS.facility1,
            user_role: 'doctor',
          },
          error: null,
        }),
      },
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            return { data: { id: UUIDS.visit1 }, error: null };
          }
          return {
            data: {
              id: UUIDS.visit1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              assigned_doctor: UUIDS.profile1,
              patient_id: UUIDS.patient1,
              status: 'with_doctor',
              visit_notes: null,
              weight: 65,
              blood_pressure: '120/80',
            },
            error: null,
          };
        },
      },
      patients: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.patient1,
            age: 30,
            gender: 'male',
            date_of_birth: null,
          },
          error: null,
        }),
      },
    });

    const payload: any = buildValidPayload();
    payload.action = 'complete';
    payload.medicalHistory.familyHistory = 'No known family history';
    payload.followUp = '';
    payload.clinicalNotes = {
      observations: 'Stable patient',
      diagnosis: 'Acute respiratory infection',
      nextSteps: '',
    };

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(payload);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      code: 'VALIDATION_DH_SW_004_FOLLOW_UP_REQUIRED_FOR_COMPLETION',
      message: 'Follow-up plan is missing. Add timeframe or next-step instruction before final completion.',
    });
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces SW-005 discharge acknowledgement and returns warning when acknowledged', async () => {
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

    (supabaseAdmin as any).from = createFromStub({
      users: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.profile1,
            tenant_id: UUIDS.tenant1,
            facility_id: UUIDS.facility1,
            user_role: 'doctor',
          },
          error: null,
        }),
      },
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            return { data: { id: UUIDS.visit1 }, error: null };
          }
          return {
            data: {
              id: UUIDS.visit1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              assigned_doctor: UUIDS.profile1,
              patient_id: UUIDS.patient1,
              status: 'with_doctor',
              visit_notes: null,
              weight: 65,
              blood_pressure: '120/80',
            },
            error: null,
          };
        },
      },
      patients: {
        maybeSingle: () => ({
          data: {
            id: UUIDS.patient1,
            age: 30,
            gender: 'male',
            date_of_birth: null,
          },
          error: null,
        }),
      },
      audit_log: {
        insert: () => ({ data: null, error: null }),
      },
      outbox_events: {
        insert: () => ({ data: null, error: null }),
      },
    });

    const basePayload: any = buildValidPayload();
    basePayload.action = 'discharge';
    basePayload.followUp = '3 days';
    basePayload.medicalHistory.familyHistory = 'No known family history';
    basePayload.clinicalNotes = {
      observations: 'Stable patient',
      diagnosis: 'Acute respiratory infection',
      nextSteps: 'Follow-up in clinic',
    };
    basePayload.outstandingOrders = [
      {
        type: 'lab',
        name: 'CBC',
        status: 'pending',
      },
    ];

    const app = buildApp(doctorRouter);
    const blockResponse = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(basePayload);

    assert.equal(blockResponse.status, 400);
    assert.deepEqual(blockResponse.body, {
      code: 'VALIDATION_DH_SW_005_PENDING_ORDERS_ACK_REQUIRED',
      message: 'There are outstanding orders. Confirm discharge with pending orders or return patient for completion.',
    });

    const acknowledgedPayload = {
      ...basePayload,
      returnForOutstanding: true,
    };
    const acknowledgedResponse = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(acknowledgedPayload);

    assert.equal(acknowledgedResponse.status, 200);
    assert.equal(acknowledgedResponse.body.success, true);
    assert.ok(Array.isArray(acknowledgedResponse.body.warnings));
    const sw005 = (acknowledgedResponse.body.warnings || []).find(
      (warning: any) => warning.code === 'WARNING_DH_SW_005_OUTSTANDING_ORDERS'
    );
    assert.ok(sw005, 'Expected SW-005 warning in acknowledged discharge flow');
    assert.equal(sw005.ruleId, 'SW-005');
    assert.equal(sw005.ackRequired, true);
    assert.ok(Array.isArray(sw005.fieldKeys));
    assert.ok(sw005.meta && Array.isArray(sw005.meta.outstandingOrders));
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route enforces minimal clinical safety required fields', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  let visitTableCalls = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'visits') {
        visitTableCalls += 1;
      }
      return createFromStub({
        users: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.profile1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              user_role: 'doctor',
            },
            error: null,
          }),
        },
      })(table);
    };

    const app = buildApp(doctorRouter);
    const payload = buildValidPayload();
    payload.chiefComplaints[0].complaint = '';

    const response = await request(app)
      .post(`/api/doctor/visits/${UUIDS.visit1}/history`)
      .set('authorization', 'Bearer valid-token')
      .send(payload);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      code: 'VALIDATION_DH_HS_001_MISSING_CHIEF_COMPLAINT',
      message: 'Chief complaint is required before you can continue.',
    });
    assert.equal(visitTableCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});

test('doctor visit history route validates visit id as UUID with stable code/message', async () => {
  const { doctorRouter, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  const originalAuth = (supabaseAdmin as any).auth;

  let visitTableCalls = 0;

  try {
    (supabaseAdmin as any).auth = {
      getUser: async () => ({
        data: { user: { id: 'auth-user-1' } },
        error: null,
      }),
    };

    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'visits') {
        visitTableCalls += 1;
      }
      return createFromStub({
        users: {
          maybeSingle: () => ({
            data: {
              id: UUIDS.profile1,
              tenant_id: UUIDS.tenant1,
              facility_id: UUIDS.facility1,
              user_role: 'doctor',
            },
            error: null,
          }),
        },
      })(table);
    };

    const app = buildApp(doctorRouter);
    const response = await request(app)
      .post('/api/doctor/visits/not-a-uuid/history')
      .set('authorization', 'Bearer valid-token')
      .send(buildValidPayload());

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      code: 'VALIDATION_INVALID_VISIT_ID',
      message: 'Visit id must be a valid UUID',
    });
    assert.equal(visitTableCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).auth = originalAuth;
  }
});
