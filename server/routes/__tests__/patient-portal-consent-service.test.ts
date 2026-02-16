import test from 'node:test';
import assert from 'node:assert/strict';

const ensureSupabaseEnv = () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
  process.env.AUDIT_LOG_ENABLED = 'false';
};

type QueryState = {
  filters: Record<string, any>;
  orders: Array<{ column: string; ascending: boolean }>;
  payload?: any;
  operation: 'select' | 'insert' | 'update' | 'delete';
};

type TableHandler = {
  maybeSingle?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
  single?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
  execute?: (state: QueryState) => Promise<{ data: any; error: any }> | { data: any; error: any };
};

const createFromStub = (handlers: Record<string, TableHandler>) => {
  return (table: string) => {
    const state: QueryState = {
      filters: {},
      orders: [],
      operation: 'select',
    };
    const handler = handlers[table] || {};

    const query: any = {
      select() {
        if (state.operation === 'select') {
          state.operation = 'select';
        }
        return query;
      },
      eq(column: string, value: any) {
        state.filters[column] = value;
        return query;
      },
      order(column: string, options?: { ascending?: boolean }) {
        state.orders.push({ column, ascending: options?.ascending !== false });
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
      maybeSingle: async () => (handler.maybeSingle ? handler.maybeSingle(state) : { data: null, error: null }),
      single: async () => (handler.single ? handler.single(state) : { data: null, error: null }),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(handler.execute ? handler.execute(state) : { data: [], error: null }).then(
          onFulfilled,
          onRejected
        ),
    };

    return query;
  };
};

const loadModules = async () => {
  ensureSupabaseEnv();
  const consentService = await import('../../services/patientPortalConsentService');
  const configModule = await import('../../config/supabase');
  return {
    consentService,
    supabaseAdmin: (configModule as any).supabaseAdmin,
  };
};

test('patient portal consent grant succeeds and validation failures return stable contract error', { concurrency: false }, async () => {
  const { consentService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  let fromCalls = 0;
  let storedConsentId: string | null = null;
  const historyWrites: any[] = [];

  try {
    (supabaseAdmin as any).from = (table: string) => {
      fromCalls += 1;
      return createFromStub({
        facilities: {
          maybeSingle: () => ({ data: { id: '11111111-1111-1111-1111-111111111111', tenant_id: 'tenant-1' }, error: null }),
        },
        patient_portal_consents: {
          maybeSingle: () => ({ data: null, error: null }),
          single: (state) => {
            assert.equal(state.operation, 'insert');
            storedConsentId = 'consent-1';
            assert.equal(state.payload.consent_type, 'records_access');
            assert.equal(state.payload.patient_account_id, 'patient-1');
            return { data: { id: storedConsentId }, error: null };
          },
        },
        patient_portal_consent_history: {
          execute: (state) => {
            assert.equal(state.operation, 'insert');
            historyWrites.push(state.payload);
            return { data: [state.payload], error: null };
          },
        },
      })(table);
    };

    const successResult = await consentService.grantPatientPortalConsent({
      actor: {
        patientAccountId: 'patient-1',
        tenantId: 'tenant-1',
        role: 'patient',
      },
      payload: {
        facilityId: '11111111-1111-1111-1111-111111111111',
        consentType: 'records_access',
        comprehensionText:
          'I understand that by granting consent, this facility and its care team may view my health records to provide care.',
        comprehensionLanguage: 'en',
        comprehensionRecordedAt: new Date().toISOString(),
        comprehensionConfirmed: true,
        purpose: 'Share records with care team',
      },
    });

    assert.equal(successResult.ok, true);
    if (successResult.ok) {
      assert.equal(successResult.data.created, true);
      assert.equal(successResult.data.consent.id, storedConsentId);
      assert.equal(successResult.data.consent.isActive, true);
    }
    assert.equal(historyWrites.length, 1);

    const beforeInvalidCalls = fromCalls;
    const invalidResult = await consentService.grantPatientPortalConsent({
      actor: {
        patientAccountId: 'patient-1',
        tenantId: 'tenant-1',
        role: 'patient',
      },
      payload: {
        facilityId: 'not-a-uuid',
        consentType: '',
      },
    });

    assert.equal(invalidResult.ok, false);
    if (!invalidResult.ok) {
      assert.equal(invalidResult.status, 400);
      assert.equal(invalidResult.code, 'VALIDATION_INVALID_CONSENT_PAYLOAD');
    }
    assert.equal(fromCalls, beforeInvalidCalls);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient portal consent grant requires comprehension fields and enforces high-risk override reason', { concurrency: false }, async () => {
  const { consentService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      facilities: {
        maybeSingle: () => ({ data: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tenant_id: 'tenant-1' }, error: null }),
      },
    });

    const missingComprehension = await consentService.grantPatientPortalConsent({
      actor: { patientAccountId: 'patient-1', tenantId: 'tenant-1', role: 'patient' },
      payload: { facilityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', consentType: 'records_access' },
    });
    assert.equal(missingComprehension.ok, false);
    if (!missingComprehension.ok) {
      assert.equal(missingComprehension.status, 400);
      assert.equal(missingComprehension.code, 'VALIDATION_INVALID_CONSENT_PAYLOAD');
    }

    const overrideWithoutReason = await consentService.grantPatientPortalConsent({
      actor: { patientAccountId: 'patient-1', tenantId: 'tenant-1', role: 'patient' },
      payload: {
        facilityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        consentType: 'records_access',
        comprehensionText:
          'I understand that by granting consent, this facility and its care team may view my health records to provide care.',
        comprehensionLanguage: 'en',
        comprehensionRecordedAt: new Date().toISOString(),
        comprehensionConfirmed: true,
        highRiskOverride: true,
      },
    });
    assert.equal(overrideWithoutReason.ok, false);
    if (!overrideWithoutReason.ok) {
      assert.equal(overrideWithoutReason.status, 400);
      assert.equal(overrideWithoutReason.code, 'VALIDATION_INVALID_CONSENT_PAYLOAD');
    }

    const mismatchWithoutOverride = await consentService.grantPatientPortalConsent({
      actor: { patientAccountId: 'patient-1', tenantId: 'tenant-1', role: 'patient' },
      payload: {
        facilityId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        consentType: 'records_access',
        comprehensionText:
          'I understand that by granting consent, this facility and its care team may view my health records to provide care.',
        comprehensionLanguage: 'en',
        uiLanguage: 'fr',
        comprehensionRecordedAt: new Date().toISOString(),
        comprehensionConfirmed: true,
      },
    });
    assert.equal(mismatchWithoutOverride.ok, false);
    if (!mismatchWithoutOverride.ok) {
      assert.equal(mismatchWithoutOverride.status, 400);
      assert.equal(mismatchWithoutOverride.code, 'VALIDATION_INVALID_CONSENT_PAYLOAD');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient portal consent revoke enforces immediate access revocation', { concurrency: false }, async () => {
  const { consentService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  const consentRow = {
    id: 'consent-2',
    is_active: true,
  };

  try {
    (supabaseAdmin as any).from = createFromStub({
      facilities: {
        maybeSingle: () => ({ data: { id: '22222222-2222-2222-2222-222222222222', tenant_id: 'tenant-1' }, error: null }),
      },
      patient_portal_consents: {
        maybeSingle: (state) => {
          if (state.operation === 'select') {
            return { data: consentRow, error: null };
          }
          consentRow.is_active = false;
          return { data: { id: consentRow.id }, error: null };
        },
      },
      patient_portal_consent_history: {
        execute: () => ({ data: [], error: null }),
      },
    });

    const revokeResult = await consentService.revokePatientPortalConsent({
      actor: {
        patientAccountId: 'patient-1',
        tenantId: 'tenant-1',
        role: 'patient',
      },
      payload: {
        facilityId: '22222222-2222-2222-2222-222222222222',
        consentType: 'records_access',
        acknowledged: true,
        reason: 'No longer sharing',
      },
    });

    assert.equal(revokeResult.ok, true);
    if (revokeResult.ok) {
      assert.equal(revokeResult.data.consent.id, 'consent-2');
      assert.equal(revokeResult.data.consent.isActive, false);
    }

    const accessResult = await consentService.assertPatientPortalConsentActive({
      actor: {
        patientAccountId: 'patient-1',
        tenantId: 'tenant-1',
        role: 'patient',
      },
      facilityId: '22222222-2222-2222-2222-222222222222',
      consentType: 'records_access',
    });

    assert.equal(accessResult.ok, false);
    if (!accessResult.ok) {
      assert.equal(accessResult.status, 409);
      assert.equal(accessResult.code, 'CONFLICT_CONSENT_ACCESS_REVOKED');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient portal consent revoke requires acknowledgement', { concurrency: false }, async () => {
  const { consentService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      facilities: {
        maybeSingle: () => ({ data: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', tenant_id: 'tenant-1' }, error: null }),
      },
      patient_portal_consents: {
        maybeSingle: () => ({ data: { id: 'consent-x', is_active: true }, error: null }),
      },
    });

    const result = await consentService.revokePatientPortalConsent({
      actor: { patientAccountId: 'patient-1', tenantId: 'tenant-1', role: 'patient' },
      payload: { facilityId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', consentType: 'records_access' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.code, 'VALIDATION_INVALID_CONSENT_PAYLOAD');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient portal consent grant rejects cross-tenant facility access', { concurrency: false }, async () => {
  const { consentService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;
  let consentTableCalls = 0;

  try {
    (supabaseAdmin as any).from = (table: string) => {
      if (table === 'patient_portal_consents') {
        consentTableCalls += 1;
      }
      return createFromStub({
        facilities: {
          maybeSingle: () => ({ data: { id: '33333333-3333-3333-3333-333333333333', tenant_id: 'tenant-2' }, error: null }),
        },
      })(table);
    };

    const result = await consentService.grantPatientPortalConsent({
      actor: {
        patientAccountId: 'patient-1',
        tenantId: 'tenant-1',
        role: 'patient',
      },
      payload: {
        facilityId: '33333333-3333-3333-3333-333333333333',
        consentType: 'records_access',
        comprehensionText:
          'I understand that by granting consent, this facility and its care team may view my health records to provide care.',
        comprehensionLanguage: 'en',
        comprehensionRecordedAt: new Date().toISOString(),
        comprehensionConfirmed: true,
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 403);
      assert.equal(result.code, 'TENANT_RESOURCE_SCOPE_VIOLATION');
    }
    assert.equal(consentTableCalls, 0);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('patient portal consent history returns chronological entries with stable ordering', { concurrency: false }, async () => {
  const { consentService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  try {
    (supabaseAdmin as any).from = createFromStub({
      facilities: {
        maybeSingle: () => ({ data: { id: '44444444-4444-4444-4444-444444444444', tenant_id: 'tenant-1' }, error: null }),
      },
      patient_portal_consent_history: {
        execute: (state) => {
          assert.equal(state.filters.patient_account_id, 'patient-1');
          assert.equal(state.filters.tenant_id, 'tenant-1');
          assert.equal(state.filters.facility_id, '44444444-4444-4444-4444-444444444444');
          assert.equal(state.filters.consent_type, 'records_access');
          assert.deepEqual(state.orders, [
            { column: 'created_at', ascending: true },
            { column: 'id', ascending: true },
          ]);

          return {
            data: [
              {
                id: 'h-1',
                consent_id: 'c-1',
                facility_id: '44444444-4444-4444-4444-444444444444',
                consent_type: 'records_access',
                action: 'grant',
                reason: null,
                metadata: null,
                created_at: '2026-02-15T10:00:00.000Z',
              },
              {
                id: 'h-2',
                consent_id: 'c-1',
                facility_id: '44444444-4444-4444-4444-444444444444',
                consent_type: 'records_access',
                action: 'revoke',
                reason: 'Patient request',
                metadata: null,
                created_at: '2026-02-15T11:00:00.000Z',
              },
            ],
            error: null,
          };
        },
      },
    });

    const result = await consentService.listPatientPortalConsentHistory({
      actor: {
        patientAccountId: 'patient-1',
        tenantId: 'tenant-1',
        role: 'patient',
      },
      query: {
        facilityId: '44444444-4444-4444-4444-444444444444',
        consentType: 'records_access',
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.history.length, 2);
      assert.equal(result.data.history[0].action, 'grant');
      assert.equal(result.data.history[1].action, 'revoke');
      assert.equal(result.data.history[0].created_at, '2026-02-15T10:00:00.000Z');
      assert.equal(result.data.history[1].created_at, '2026-02-15T11:00:00.000Z');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});

test('provider read is gated by consent: deny -> allow -> deny after revoke', { concurrency: false }, async () => {
  const { consentService, supabaseAdmin } = await loadModules();
  const originalFrom = (supabaseAdmin as any).from;

  const consentRowId = 'consent-pr-1';
  let consentState: 'missing' | 'active' | 'revoked' = 'missing';
  const facilityId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  try {
    (supabaseAdmin as any).from = (table: string) =>
      createFromStub({
        facilities: {
          maybeSingle: () => ({ data: { id: facilityId, tenant_id: 'tenant-1' }, error: null }),
        },
        patient_portal_consents: {
          maybeSingle: (state) => {
            if (state.operation === 'select') {
              if (consentState === 'missing') return { data: null, error: null };
              return { data: { id: consentRowId, is_active: consentState === 'active' }, error: null };
            }
            if (state.payload?.is_active === true) consentState = 'active';
            if (state.payload?.is_active === false) consentState = 'revoked';
            return { data: { id: consentRowId }, error: null };
          },
          single: (state) => {
            assert.equal(state.operation, 'insert');
            consentState = 'active';
            return { data: { id: consentRowId }, error: null };
          },
        },
        patient_portal_consent_history: {
          execute: () => ({ data: [], error: null }),
        },
      })(table);

    const deny1 = await (consentService as any).assertPatientPortalConsentActiveForProviderRead({
      tenantId: 'tenant-1',
      patientAccountId: 'patient-1',
      facilityId,
      consentType: 'records_access',
    });
    assert.equal(deny1.ok, false);
    if (!deny1.ok) {
      assert.equal(deny1.status, 403);
      assert.equal(deny1.code, 'PERM_PHI_CONSENT_REQUIRED');
    }

    const grant = await consentService.grantPatientPortalConsent({
      actor: { patientAccountId: 'patient-1', tenantId: 'tenant-1', role: 'patient' },
      payload: {
        facilityId,
        consentType: 'records_access',
        comprehensionText:
          'I understand that by granting consent, this facility and its care team may view my health records to provide care.',
        comprehensionLanguage: 'en',
        comprehensionRecordedAt: new Date().toISOString(),
        comprehensionConfirmed: true,
      },
    });
    assert.equal(grant.ok, true);

    const allow = await (consentService as any).assertPatientPortalConsentActiveForProviderRead({
      tenantId: 'tenant-1',
      patientAccountId: 'patient-1',
      facilityId,
      consentType: 'records_access',
    });
    assert.equal(allow.ok, true);

    const revoke = await consentService.revokePatientPortalConsent({
      actor: { patientAccountId: 'patient-1', tenantId: 'tenant-1', role: 'patient' },
      payload: { facilityId, consentType: 'records_access', acknowledged: true, reason: 'Revoked' },
    });
    assert.equal(revoke.ok, true);

    const deny2 = await (consentService as any).assertPatientPortalConsentActiveForProviderRead({
      tenantId: 'tenant-1',
      patientAccountId: 'patient-1',
      facilityId,
      consentType: 'records_access',
    });
    assert.equal(deny2.ok, false);
    if (!deny2.ok) {
      assert.equal(deny2.status, 409);
      assert.equal(deny2.code, 'CONFLICT_CONSENT_ACCESS_REVOKED');
    }
  } finally {
    (supabaseAdmin as any).from = originalFrom;
  }
});
