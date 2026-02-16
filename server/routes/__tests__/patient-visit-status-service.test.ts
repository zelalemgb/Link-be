import test from 'node:test';
import assert from 'node:assert/strict';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

type QueryState = {
  filters: Record<string, any>;
  payload?: any;
  operation: 'select' | 'update' | 'insert';
};

type TableHandler = {
  maybeSingle?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
  insert?: (payload: any, state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
};

const createFromStub = (handlers: Record<string, TableHandler>) => {
  return (table: string) => {
    const state: QueryState = {
      filters: {},
      operation: 'select',
    };
    const handler = handlers[table] || {};

    const query: any = {
      select() {
        return query;
      },
      update(payload: any) {
        state.operation = 'update';
        state.payload = payload;
        return query;
      },
      insert: async (payload: any) => {
        state.operation = 'insert';
        state.payload = payload;
        if (handler.insert) {
          return handler.insert(payload, state);
        }
        return { data: { id: 'insert-1' }, error: null };
      },
      eq(column: string, value: any) {
        state.filters[column] = value;
        return query;
      },
      maybeSingle: async () => (handler.maybeSingle ? handler.maybeSingle(state) : { data: null, error: null }),
    };

    return query;
  };
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const patientVisitStatusService = await import('../../services/patientVisitStatusService');
  const configModule = await import('../../config/supabase');
  return {
    patientVisitStatusService,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('patient visit status mutation supports doctor metadata fields on authorized success', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let capturedUpdatePayload: Record<string, any> | null = null;

  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'visits') {
        return createFromStub({
          visits: {
            maybeSingle: (state) => {
              if (state.operation === 'select') {
                return {
                  data: {
                    id: 'visit-1',
                    status: 'with_doctor',
                    facility_id: 'facility-1',
                    tenant_id: 'tenant-1',
                  },
                  error: null,
                };
              }

              capturedUpdatePayload = state.payload || null;
              return {
                data: { id: 'visit-1' },
                error: null,
              };
            },
          },
        })(table);
      }

      // Strict-audit admitted/discharged transitions must be able to insert audit rows.
      if (table === 'audit_log') {
        return {
          insert: async () => ({ data: null, error: null }),
        };
      }
      if (table === 'outbox_events') {
        return {
          insert: async () => ({ data: null, error: null }),
        };
      }

      return createFromStub({})(table);
    };

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'doctor',
      },
      visitId: 'visit-1',
      payload: {
        status: 'admitted',
        visitNotes: 'Assessment done',
        provider: 'Dr. Example',
        assessmentCompleted: true,
        assessedAt: '2026-02-15T10:20:30.000Z',
        assessedBy: 'd6e0f0a0-0b4d-4f5a-a21e-fd9f1e1881e5',
        admissionWard: 'Ward A',
        admissionBed: 'Bed 3',
        admittedAt: '2026-02-15T10:25:30.000Z',
        routingStatus: 'routing_in_progress',
        statusUpdatedAt: '2026-02-15T10:26:00.000Z',
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.success, true);
    }
    assert.ok(capturedUpdatePayload);
    assert.equal(capturedUpdatePayload?.status, 'admitted');
    assert.equal(capturedUpdatePayload?.provider, 'Dr. Example');
    assert.equal(capturedUpdatePayload?.assessment_completed, true);
    assert.equal(capturedUpdatePayload?.assessed_at, '2026-02-15T10:20:30.000Z');
    assert.equal(capturedUpdatePayload?.assessed_by, 'd6e0f0a0-0b4d-4f5a-a21e-fd9f1e1881e5');
    assert.equal(capturedUpdatePayload?.admission_ward, 'Ward A');
    assert.equal(capturedUpdatePayload?.admission_bed, 'Bed 3');
    assert.equal(capturedUpdatePayload?.admitted_at, '2026-02-15T10:25:30.000Z');
    assert.equal(capturedUpdatePayload?.routing_status, 'routing_in_progress');
    assert.equal(capturedUpdatePayload?.status_updated_at, '2026-02-15T10:26:00.000Z');
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status schema rejects invalid payload contract', async () => {
  const { patientVisitStatusService } = await loadModules();

  const invalidStatus = patientVisitStatusService.visitStatusMutationSchema.safeParse({
    status: 'unknown_status',
  });
  assert.equal(invalidStatus.success, false);

  const invalidTimestamp = patientVisitStatusService.visitStatusMutationSchema.safeParse({
    status: 'with_doctor',
    admittedAt: 'not-an-iso-time',
  });
  assert.equal(invalidTimestamp.success, false);
});

test('patient visit status mutation rejects unauthorized and forbidden actors', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let fromCalls = 0;

  try {
    (supabaseAdmin as any).from = () => {
      fromCalls += 1;
      return createFromStub({})('visits');
    };

    const unauthorized = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'doctor',
      },
      visitId: 'visit-1',
      payload: {
        status: 'with_doctor',
      },
    });

    assert.equal(unauthorized.ok, false);
    if (!unauthorized.ok) {
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.code, 'AUTH_MISSING_USER_CONTEXT');
    }

    const forbidden = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        role: 'doctor',
      },
      visitId: 'visit-1',
      payload: {
        status: 'with_doctor',
      },
    });

    assert.equal(forbidden.ok, false);
    if (!forbidden.ok) {
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.code, 'TENANT_MISSING_SCOPE_CONTEXT');
    }
    assert.equal(fromCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation rejects cross-tenant or cross-facility updates', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let updateCalled = false;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            updateCalled = true;
          }
          return {
            data: {
              id: 'visit-1',
              status: 'with_doctor',
              facility_id: 'facility-2',
              tenant_id: 'tenant-2',
            },
            error: null,
          };
        },
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'doctor',
      },
      visitId: 'visit-1',
      payload: {
        status: 'with_doctor',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.code, 'TENANT_RESOURCE_SCOPE_VIOLATION');
    }
    assert.equal(updateCalled, false);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation enforces role guard for with_doctor transitions', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let updateCalled = false;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            updateCalled = true;
          }
          return {
            data: {
              id: 'visit-1',
              status: 'with_doctor',
              facility_id: 'facility-1',
              tenant_id: 'tenant-1',
            },
            error: null,
          };
        },
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'nurse',
      },
      visitId: 'visit-1',
      payload: {
        status: 'at_lab',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.code, 'PERM_VISIT_STATUS_TRANSITION_FORBIDDEN');
    }
    assert.equal(updateCalled, false);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation blocks transitions out of discharged terminal state', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: () => ({
          data: {
            id: 'visit-1',
            status: 'discharged',
            facility_id: 'facility-1',
            tenant_id: 'tenant-1',
          },
          error: null,
        }),
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'super_admin',
      },
      visitId: 'visit-1',
      payload: {
        status: 'with_doctor',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.equal(result.code, 'CONFLICT_TERMINAL_VISIT_STATUS');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation blocks admitted to with_doctor transition', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: () => ({
          data: {
            id: 'visit-1',
            status: 'admitted',
            facility_id: 'facility-1',
            tenant_id: 'tenant-1',
          },
          error: null,
        }),
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'doctor',
      },
      visitId: 'visit-1',
      payload: {
        status: 'with_doctor',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.equal(result.code, 'CONFLICT_INVALID_VISIT_STATUS_TRANSITION');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation rejects admitted transition when required admission metadata is missing', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: () => ({
          data: {
            id: 'visit-1',
            status: 'with_doctor',
            facility_id: 'facility-1',
            tenant_id: 'tenant-1',
            provider: null,
            visit_notes: null,
            assessment_completed: null,
            assessed_at: null,
            assessed_by: null,
            admission_ward: null,
            admission_bed: null,
            admitted_at: null,
            routing_status: null,
          },
          error: null,
        }),
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'doctor',
      },
      visitId: 'visit-1',
      payload: {
        status: 'admitted',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.code, 'VALIDATION_REQUIRED_ADMISSION_METADATA');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation rejects discharged transition when required discharge metadata is missing', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: () => ({
          data: {
            id: 'visit-1',
            status: 'admitted',
            facility_id: 'facility-1',
            tenant_id: 'tenant-1',
            provider: null,
            visit_notes: null,
            assessment_completed: null,
            assessed_at: null,
            assessed_by: null,
            admission_ward: 'Ward A',
            admission_bed: 'Bed 3',
            admitted_at: '2026-02-15T10:25:30.000Z',
            routing_status: 'routing_in_progress',
          },
          error: null,
        }),
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'super_admin',
      },
      visitId: 'visit-1',
      payload: {
        status: 'discharged',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.code, 'VALIDATION_REQUIRED_DISCHARGE_METADATA');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation keeps role/state guardrails enforced for admitted-to-discharged transition', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let updateCalled = false;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            updateCalled = true;
          }
          return {
            data: {
              id: 'visit-1',
              status: 'admitted',
              facility_id: 'facility-1',
              tenant_id: 'tenant-1',
              provider: 'Dr. Example',
              visit_notes: 'Admission rationale and handoff documented',
              assessment_completed: true,
              assessed_at: '2026-02-15T10:20:30.000Z',
              assessed_by: 'd6e0f0a0-0b4d-4f5a-a21e-fd9f1e1881e5',
              admission_ward: 'Ward A',
              admission_bed: 'Bed 3',
              admitted_at: '2026-02-15T10:25:30.000Z',
              routing_status: 'completed',
            },
            error: null,
          };
        },
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'receptionist',
      },
      visitId: 'visit-1',
      payload: {
        status: 'discharged',
        provider: 'Dr. Example',
        visitNotes: 'Diagnosis and follow-up documented',
        assessmentCompleted: true,
        assessedAt: '2026-02-15T11:20:30.000Z',
        assessedBy: 'd6e0f0a0-0b4d-4f5a-a21e-fd9f1e1881e5',
        routingStatus: 'completed',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.code, 'PERM_VISIT_STATUS_TRANSITION_FORBIDDEN');
    }
    assert.equal(updateCalled, false);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation rejects admitted transition without required metadata', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let updateCalled = false;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            updateCalled = true;
          }
          return {
            data: {
              id: 'visit-1',
              status: 'with_doctor',
              facility_id: 'facility-1',
              tenant_id: 'tenant-1',
              provider: null,
              visit_notes: null,
              assessment_completed: null,
              assessed_at: null,
              assessed_by: null,
              admission_ward: null,
              admission_bed: null,
              admitted_at: null,
              routing_status: null,
            },
            error: null,
          };
        },
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'doctor',
      },
      visitId: 'visit-1',
      payload: {
        status: 'admitted',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.code, 'VALIDATION_REQUIRED_ADMISSION_METADATA');
      assert.match(result.message, /admissionWard/);
      assert.match(result.message, /admissionBed/);
      assert.match(result.message, /admittedAt/);
    }
    assert.equal(updateCalled, false);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation rejects discharged transition without required metadata', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let updateCalled = false;

  try {
    (supabaseAdmin as any).from = createFromStub({
      visits: {
        maybeSingle: (state) => {
          if (state.operation === 'update') {
            updateCalled = true;
          }
          return {
            data: {
              id: 'visit-1',
              status: 'admitted',
              facility_id: 'facility-1',
              tenant_id: 'tenant-1',
              provider: 'Dr. Existing',
              visit_notes: 'Stable',
              assessment_completed: false,
              assessed_at: null,
              assessed_by: null,
              admission_ward: 'Ward A',
              admission_bed: 'Bed 1',
              admitted_at: '2026-02-15T10:00:00.000Z',
              routing_status: 'routing_in_progress',
            },
            error: null,
          };
        },
      },
    });

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'super_admin',
      },
      visitId: 'visit-1',
      payload: {
        status: 'discharged',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.code, 'VALIDATION_REQUIRED_DISCHARGE_METADATA');
      assert.match(result.message, /assessmentCompleted=true/);
    }
    assert.equal(updateCalled, false);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient visit status mutation fails closed on strict audit durability failure for admitted transition', async () => {
  const { patientVisitStatusService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'visits') {
        const state: any = { op: 'select', payload: null };
        const query: any = {
          select() {
            state.op = 'select';
            return query;
          },
          update(payload: any) {
            state.op = 'update';
            state.payload = payload;
            return query;
          },
          eq() {
            return query;
          },
          maybeSingle: async () => {
            if (state.op === 'select') {
              return {
                data: {
                  id: 'visit-1',
                  status: 'with_doctor',
                  facility_id: 'facility-1',
                  tenant_id: 'tenant-1',
                  provider: null,
                  visit_notes: null,
                  assessment_completed: null,
                  assessed_at: null,
                  assessed_by: null,
                  admission_ward: null,
                  admission_bed: null,
                  admitted_at: null,
                  routing_status: null,
                },
                error: null,
              };
            }
            return { data: { id: 'visit-1' }, error: null };
          },
        };
        return query;
      }

      return {
        insert: async () => ({ data: null, error: { message: 'outbox write failed' } }),
      };
    };

    const result = await patientVisitStatusService.updateVisitStatusMutation({
      actor: {
        authUserId: 'auth-user-1',
        profileId: 'profile-1',
        tenantId: 'tenant-1',
        facilityId: 'facility-1',
        role: 'doctor',
        requestId: '50000000-0000-4000-8000-000000000001',
      },
      visitId: 'visit-1',
      payload: {
        status: 'admitted',
        visitNotes: 'Admission rationale documented',
        provider: 'Dr. Example',
        admissionWard: 'Ward A',
        admissionBed: 'Bed 3',
        admittedAt: '2026-02-15T10:25:30.000Z',
        routingStatus: 'routing_in_progress',
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, 'CONFLICT_AUDIT_DURABILITY_FAILURE');
      assert.equal(result.message, 'Audit durability requirement failed');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
