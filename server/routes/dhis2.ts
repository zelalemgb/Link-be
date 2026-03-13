import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase';
import { requireScopedUser, requireUser } from '../middleware/auth';
import {
  buildMappedDhis2DataValues,
  buildSubmissionBatchId,
  type Dhis2ConnectionConfig,
  type Dhis2IndicatorMapping,
  Dhis2RequestError,
  fetchDhis2DataSetMetadata,
  isPeriodCompatibleWithDataSet,
  persistDhis2SubmissionRows,
  submitDhis2DataValueSet,
  testDhis2Connection,
  updateFacilityDhis2OrgUnit,
} from '../services/dhis2';

const router = Router();

const uuidSchema = z.string().uuid();

type ScopedRequest = Request & {
  user?: {
    authUserId?: string;
    facilityId?: string;
    tenantId?: string;
    role?: string;
  };
};

type FacilityContextRow = {
  tenant_id?: string | null;
  dhis2_org_unit_uid?: string | null;
};

type StoredDhis2Connection = {
  baseUrl: string;
  authMode: 'basic' | 'pat';
  username: string;
  password: string;
  personalAccessToken: string;
  dataSetId: string;
  completeDataSet: boolean;
  dryRun: boolean;
  periodOverride: string;
};

type PublicDhis2Connection = Omit<StoredDhis2Connection, 'password' | 'personalAccessToken'> & {
  hasPassword: boolean;
  hasPersonalAccessToken: boolean;
};

type StoredDhis2Settings = {
  connection: StoredDhis2Connection;
  mappingsByProgram: Record<string, Record<string, Dhis2IndicatorMapping>>;
};

const dhis2ConnectionShape = {
  baseUrl: z.string().trim().url(),
  authMode: z.enum(['basic', 'pat']).default('basic'),
  username: z.string().trim().optional().nullable(),
  password: z.string().optional().nullable(),
  personalAccessToken: z.string().trim().optional().nullable(),
  orgUnit: z.string().trim().max(64).optional().nullable(),
  dataSetId: z.string().trim().max(64).optional().nullable(),
  completeDataSet: z.boolean().optional(),
  dryRun: z.boolean().optional(),
};

const dhis2ConnectionSchemaBase = z.object(dhis2ConnectionShape);

const dhis2ConnectionSchema = dhis2ConnectionSchemaBase
  .superRefine((value, ctx) => {
    if (value.authMode === 'basic') {
      if (!String(value.username || '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DHIS2 username is required for basic authentication',
          path: ['username'],
        });
      }
      if (!String(value.password || '')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DHIS2 password is required for basic authentication',
          path: ['password'],
        });
      }
    }

    if (value.authMode === 'pat' && !String(value.personalAccessToken || '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DHIS2 personal access token is required for token authentication',
        path: ['personalAccessToken'],
      });
    }
  });

const dhis2SubmissionConnectionSchema = dhis2ConnectionSchemaBase
  .extend({
    orgUnit: z.string().trim().min(1).max(64),
  })
  .superRefine((value, ctx) => {
    if (value.authMode === 'basic') {
      if (!String(value.username || '').trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DHIS2 username is required for basic authentication',
          path: ['username'],
        });
      }
      if (!String(value.password || '')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'DHIS2 password is required for basic authentication',
          path: ['password'],
        });
      }
    }

    if (value.authMode === 'pat' && !String(value.personalAccessToken || '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DHIS2 personal access token is required for token authentication',
        path: ['personalAccessToken'],
      });
    }
  });

const indicatorMappingSchema = z.object({
  dataElement: z.string().trim().min(1).max(64),
  dataElementName: z.string().trim().max(256).optional().nullable(),
  categoryOptionCombo: z.string().trim().max(64).optional().nullable(),
  attributeOptionCombo: z.string().trim().max(64).optional().nullable(),
});

const testConnectionSchema = z.object({
  connection: dhis2ConnectionSchema,
});

const metadataSchema = z.object({
  connection: dhis2ConnectionSchema,
  dataSetId: z.string().trim().min(1).max(64).optional(),
});

const reportSchema = z.object({
  program: z.string().trim().min(1).max(32),
  period: z.string().trim().min(4).max(32),
  completeDate: z.string().trim().min(8).max(10).optional().nullable(),
  comment: z.string().trim().max(2000).optional().nullable(),
  values: z.record(z.union([z.number(), z.string(), z.null()])).default({}),
  mappings: z.record(indicatorMappingSchema).default({}),
  review: z
    .object({
      preparedBy: z.string().trim().max(120).optional().nullable(),
      preparedAt: z.string().trim().max(64).optional().nullable(),
      reviewedBy: z.string().trim().max(120).optional().nullable(),
      reviewedAt: z.string().trim().max(64).optional().nullable(),
      approvedBy: z.string().trim().max(120).optional().nullable(),
      approvedAt: z.string().trim().max(64).optional().nullable(),
      notes: z.string().trim().max(2000).optional().nullable(),
    })
    .optional()
    .nullable(),
});

const toConnectionConfig = (
  connection: z.output<typeof dhis2ConnectionSchemaBase>
): Dhis2ConnectionConfig => ({
  baseUrl: connection.baseUrl,
  authMode: connection.authMode,
  username: connection.username || null,
  password: connection.password || null,
  personalAccessToken: connection.personalAccessToken || null,
});

const toIndicatorMappings = (
  mappings: z.output<typeof reportSchema>['mappings']
): Record<string, Dhis2IndicatorMapping> =>
  Object.fromEntries(
    Object.entries(mappings).map(([indicatorCode, mapping]) => [
      indicatorCode,
      {
        dataElement: mapping.dataElement,
        dataElementName: mapping.dataElementName || null,
        categoryOptionCombo: mapping.categoryOptionCombo || null,
        attributeOptionCombo: mapping.attributeOptionCombo || null,
      },
    ])
  );

const dhis2ConfigQuerySchema = z.object({
  facilityId: uuidSchema.optional(),
});

const dhis2ConfigUpdateSchema = z.object({
  facilityId: uuidSchema.optional(),
  orgUnitRef: z.string().trim().min(1).max(64),
  connection: dhis2ConnectionSchemaBase,
  mappingsByProgram: z.record(z.record(indicatorMappingSchema)).default({}),
});

const submitSchema = z.object({
  facilityId: uuidSchema.optional(),
  connection: dhis2SubmissionConnectionSchema.optional(),
  report: reportSchema,
});

const buildDefaultStoredDhis2Connection = (): StoredDhis2Connection => ({
  baseUrl: '',
  authMode: 'basic',
  username: '',
  password: '',
  personalAccessToken: '',
  dataSetId: '',
  completeDataSet: false,
  dryRun: true,
  periodOverride: '',
});

const normalizeStoredConnection = (value: unknown): StoredDhis2Connection => {
  const source = (value || {}) as Partial<StoredDhis2Connection>;
  return {
    ...buildDefaultStoredDhis2Connection(),
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : '',
    authMode: source.authMode === 'pat' ? 'pat' : 'basic',
    username: typeof source.username === 'string' ? source.username : '',
    password: typeof source.password === 'string' ? source.password : '',
    personalAccessToken:
      typeof source.personalAccessToken === 'string' ? source.personalAccessToken : '',
    dataSetId: typeof source.dataSetId === 'string' ? source.dataSetId : '',
    completeDataSet: Boolean(source.completeDataSet),
    dryRun: source.dryRun !== false,
    periodOverride: typeof source.periodOverride === 'string' ? source.periodOverride : '',
  };
};

const normalizeMappingsByProgram = (
  value: unknown
): Record<string, Record<string, Dhis2IndicatorMapping>> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([program, mappings]) => {
      if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
        return [program, {}];
      }

      return [
        program,
        Object.fromEntries(
          Object.entries(mappings as Record<string, unknown>).map(([indicatorCode, rawMapping]) => {
            const mapping = (rawMapping || {}) as Partial<Dhis2IndicatorMapping>;
            return [
              indicatorCode,
              {
                dataElement: typeof mapping.dataElement === 'string' ? mapping.dataElement : '',
                dataElementName:
                  typeof mapping.dataElementName === 'string' ? mapping.dataElementName : null,
                categoryOptionCombo:
                  typeof mapping.categoryOptionCombo === 'string'
                    ? mapping.categoryOptionCombo
                    : null,
                attributeOptionCombo:
                  typeof mapping.attributeOptionCombo === 'string'
                    ? mapping.attributeOptionCombo
                    : null,
              },
            ];
          })
        ),
      ];
    })
  );
};

const normalizeStoredDhis2Settings = (value: unknown): StoredDhis2Settings => {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    connection: normalizeStoredConnection(source.connection),
    mappingsByProgram: normalizeMappingsByProgram(source.mappingsByProgram),
  };
};

const toPublicConnection = (connection: StoredDhis2Connection): PublicDhis2Connection => ({
  baseUrl: connection.baseUrl,
  authMode: connection.authMode,
  username: connection.username,
  dataSetId: connection.dataSetId,
  completeDataSet: connection.completeDataSet,
  dryRun: connection.dryRun,
  periodOverride: connection.periodOverride,
  hasPassword: Boolean(connection.password),
  hasPersonalAccessToken: Boolean(connection.personalAccessToken),
});

const isStoredConfigComplete = (connection: StoredDhis2Connection, orgUnit: string | null | undefined) => {
  if (!connection.baseUrl.trim() || !String(orgUnit || '').trim()) return false;
  if (connection.authMode === 'basic') {
    return Boolean(connection.username.trim() && connection.password);
  }
  return Boolean(connection.personalAccessToken.trim());
};

const mergeStoredConnection = (
  existing: StoredDhis2Connection,
  incoming: z.output<typeof dhis2ConnectionSchema>
): StoredDhis2Connection => {
  const normalizedIncoming = normalizeStoredConnection(incoming);

  if (normalizedIncoming.authMode === 'basic') {
    return {
      ...normalizedIncoming,
      username: normalizedIncoming.username || existing.username,
      password:
        normalizedIncoming.password ||
        (existing.authMode === 'basic' ? existing.password : ''),
      personalAccessToken: '',
    };
  }

  return {
    ...normalizedIncoming,
    username: '',
    password: '',
    personalAccessToken:
      normalizedIncoming.personalAccessToken ||
      (existing.authMode === 'pat' ? existing.personalAccessToken : ''),
  };
};

const loadTenantSettingsRow = async (tenantId?: string | null) => {
  if (!tenantId) return null;

  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('settings')
    .eq('id', tenantId)
    .maybeSingle();

  if (error) {
    throw new Dhis2RequestError(500, `Failed to load DHIS2 settings: ${error.message}`, error);
  }

  return (data || null) as { settings?: unknown } | null;
};

const extractStoredDhis2Settings = (value: unknown) => {
  const settingsObject =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return normalizeStoredDhis2Settings(settingsObject.dhis2);
};

const mergeTenantSettingsWithDhis2 = (value: unknown, dhis2: StoredDhis2Settings) => {
  const settingsObject =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};

  settingsObject.dhis2 = dhis2;
  return settingsObject;
};

const resolveFacilityAccess = async (req: ScopedRequest, facilityId: string) => {
  const { role, authUserId, facilityId: defaultFacilityId, tenantId } = req.user || {};
  if (!facilityId) return false;
  if (role === 'super_admin') return true;

  if (defaultFacilityId && defaultFacilityId === facilityId) {
    return true;
  }

  if (!authUserId) return false;

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, tenant_id')
    .eq('auth_user_id', authUserId)
    .eq('facility_id', facilityId)
    .maybeSingle();

  if (error || !data) return false;
  if (tenantId && data.tenant_id && data.tenant_id !== tenantId) return false;

  return true;
};

const resolveFacilityContext = async (req: ScopedRequest, requestedFacilityId?: string | null) => {
  const facilityId = String(requestedFacilityId || req.user?.facilityId || '').trim();
  if (!facilityId) {
    return {
      facilityId: null,
      tenantId: req.user?.tenantId || null,
    };
  }

  const hasAccess = await resolveFacilityAccess(req, facilityId);
  if (!hasAccess) {
    throw new Dhis2RequestError(403, 'Forbidden: Facility access denied');
  }

  let query = supabaseAdmin
    .from('facilities')
    .select('id, tenant_id, dhis2_org_unit_uid')
    .eq('id', facilityId);

  if (req.user?.role !== 'super_admin' && req.user?.tenantId) {
    query = query.eq('tenant_id', req.user.tenantId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Dhis2RequestError(500, `Failed to resolve facility context: ${error.message}`, error);
  }
  const facilityRow = (data || null) as FacilityContextRow | null;

  return {
    facilityId,
    tenantId: facilityRow?.tenant_id || req.user?.tenantId || null,
    orgUnitUid: facilityRow?.dhis2_org_unit_uid || null,
  };
};

const sendDhis2Error = (res: Response, error: unknown) => {
  if (error instanceof Dhis2RequestError) {
    return res.status(error.status).json({
      error: error.message,
      details: error.details,
    });
  }

  const message = error instanceof Error ? error.message : 'Internal server error';
  return res.status(500).json({ error: message });
};

router.post('/test-connection', requireUser, requireScopedUser, async (req, res) => {
  const parsed = testConnectionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const result = await testDhis2Connection(toConnectionConfig(parsed.data.connection));
    return res.json(result);
  } catch (error) {
    return sendDhis2Error(res, error);
  }
});

router.post('/metadata', requireUser, requireScopedUser, async (req, res) => {
  const parsed = metadataSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const connection = parsed.data.connection;
    const connectionConfig = toConnectionConfig(connection);
    const connectionResult = await testDhis2Connection(connectionConfig);
    const dataSetId = parsed.data.dataSetId || connection.dataSetId || '';

    const dataSet = dataSetId
      ? await fetchDhis2DataSetMetadata(connectionConfig, dataSetId)
      : null;

    return res.json({
      ...connectionResult,
      dataSet,
    });
  } catch (error) {
    return sendDhis2Error(res, error);
  }
});

router.get('/config', requireUser, requireScopedUser, async (req, res) => {
  const parsed = dhis2ConfigQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid query' });
  }

  try {
    const { tenantId, orgUnitUid } = await resolveFacilityContext(req, parsed.data.facilityId);
    const tenantRow = await loadTenantSettingsRow(tenantId);
    const storedSettings = extractStoredDhis2Settings(tenantRow?.settings);

    return res.json({
      configured: isStoredConfigComplete(storedSettings.connection, orgUnitUid),
      orgUnitRef: String(orgUnitUid || '').trim(),
      connection: toPublicConnection(storedSettings.connection),
      mappingsByProgram: storedSettings.mappingsByProgram,
    });
  } catch (error) {
    return sendDhis2Error(res, error);
  }
});

router.put('/config', requireUser, requireScopedUser, async (req, res) => {
  const parsed = dhis2ConfigUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { facilityId, tenantId } = await resolveFacilityContext(req, parsed.data.facilityId);
    if (!facilityId || !tenantId) {
      return res.status(400).json({ error: 'Facility workspace is required for DHIS2 configuration' });
    }

    const tenantRow = await loadTenantSettingsRow(tenantId);
    const existingSettings = extractStoredDhis2Settings(tenantRow?.settings);
    const mergedConnection = mergeStoredConnection(existingSettings.connection, parsed.data.connection);
    const validatedConnection = dhis2ConnectionSchema.safeParse(mergedConnection);
    if (!validatedConnection.success) {
      return res.status(400).json({
        error: validatedConnection.error.issues[0]?.message || 'Invalid DHIS2 configuration',
      });
    }

    const nextStoredSettings: StoredDhis2Settings = {
      connection: normalizeStoredConnection(validatedConnection.data),
      mappingsByProgram: normalizeMappingsByProgram(parsed.data.mappingsByProgram),
    };

    const { error: updateTenantError } = await supabaseAdmin
      .from('tenants')
      .update({
        settings: mergeTenantSettingsWithDhis2(tenantRow?.settings, nextStoredSettings),
      })
      .eq('id', tenantId);

    if (updateTenantError) {
      throw new Dhis2RequestError(
        500,
        `Failed to save DHIS2 settings: ${updateTenantError.message}`,
        updateTenantError
      );
    }

    await updateFacilityDhis2OrgUnit({
      facilityId,
      tenantId,
      orgUnit: parsed.data.orgUnitRef,
    });

    return res.json({
      configured: isStoredConfigComplete(nextStoredSettings.connection, parsed.data.orgUnitRef),
      orgUnitRef: parsed.data.orgUnitRef,
      connection: toPublicConnection(nextStoredSettings.connection),
      mappingsByProgram: nextStoredSettings.mappingsByProgram,
    });
  } catch (error) {
    return sendDhis2Error(res, error);
  }
});

router.post('/submit', requireUser, requireScopedUser, async (req, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payload' });
  }

  try {
    const { facilityId, tenantId, orgUnitUid } = await resolveFacilityContext(req, parsed.data.facilityId);
    const { connection: submittedConnection, report } = parsed.data;
    const shouldLoadStoredSettings =
      !submittedConnection || Object.keys(report.mappings || {}).length === 0;
    const tenantRow = shouldLoadStoredSettings ? await loadTenantSettingsRow(tenantId) : null;
    const storedSettings = shouldLoadStoredSettings
      ? extractStoredDhis2Settings(tenantRow?.settings)
      : normalizeStoredDhis2Settings(null);

    const effectiveConnection = submittedConnection
      ? submittedConnection
      : {
          ...storedSettings.connection,
          orgUnit: String(orgUnitUid || '').trim(),
        };

    const validatedConnection = dhis2SubmissionConnectionSchema.safeParse(effectiveConnection);
    if (!validatedConnection.success) {
      return res.status(400).json({
        error:
          validatedConnection.error.issues[0]?.message ||
          'DHIS2 integration is not configured for this facility',
      });
    }

    const connection = validatedConnection.data;
    const effectiveMappings =
      Object.keys(report.mappings || {}).length > 0
        ? report.mappings
        : storedSettings.mappingsByProgram[report.program] || {};
    const connectionConfig = toConnectionConfig(connection);

    let dataSetMetadata: Awaited<ReturnType<typeof fetchDhis2DataSetMetadata>> | null = null;
    if (connection.dataSetId) {
      dataSetMetadata = await fetchDhis2DataSetMetadata(connectionConfig, connection.dataSetId);
      if (!isPeriodCompatibleWithDataSet(dataSetMetadata.periodType, report.period)) {
        return res.status(400).json({
          error: `DHIS2 period ${report.period} is not compatible with dataset period type ${dataSetMetadata.periodType}`,
        });
      }
    }

    const comment = [report.comment, report.review?.notes]
      .filter((value) => String(value || '').trim())
      .join(' | ')
      .slice(0, 2000);

    const dataValues = buildMappedDhis2DataValues({
      values: report.values,
      mappings: toIndicatorMappings(effectiveMappings),
      orgUnit: connection.orgUnit,
      period: report.period,
      comment,
    });

    const submission = await submitDhis2DataValueSet({
      config: connectionConfig,
      dataValues,
      dataSetId: connection.completeDataSet ? connection.dataSetId || null : null,
      completeDate: connection.completeDataSet ? report.completeDate || new Date().toISOString().slice(0, 10) : null,
      dryRun: connection.dryRun,
    });

    const batchId = buildSubmissionBatchId(report.program);
    const persistedRows = await persistDhis2SubmissionRows({
      facilityId,
      tenantId,
      program: report.program,
      orgUnit: connection.orgUnit,
      period: report.period,
      dataValues,
      batchId,
      dryRun: connection.dryRun,
      comment,
    });

    await updateFacilityDhis2OrgUnit({
      facilityId,
      tenantId,
      orgUnit: connection.orgUnit,
    });

    return res.json({
      batchId,
      dryRun: Boolean(connection.dryRun),
      persistedRows,
      importSummary: submission.importSummary,
      requestBody: submission.requestBody,
      dataSet: dataSetMetadata
        ? {
            id: dataSetMetadata.id,
            name: dataSetMetadata.name,
            periodType: dataSetMetadata.periodType,
          }
        : null,
    });
  } catch (error) {
    return sendDhis2Error(res, error);
  }
});

export default router;
