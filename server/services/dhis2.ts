import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase';

export const DHIS2_DEFAULT_OPTION_COMBO_UID = 'HllvX50cXC0';

export type Dhis2AuthMode = 'basic' | 'pat';

export type Dhis2ConnectionConfig = {
  baseUrl: string;
  authMode: Dhis2AuthMode;
  username?: string | null;
  password?: string | null;
  personalAccessToken?: string | null;
};

export type Dhis2IndicatorMapping = {
  dataElement: string;
  dataElementName?: string | null;
  categoryOptionCombo?: string | null;
  attributeOptionCombo?: string | null;
};

export type Dhis2SubmissionDataValue = {
  dataElement: string;
  period: string;
  orgUnit: string;
  categoryOptionCombo?: string;
  attributeOptionCombo?: string;
  value: string;
  comment?: string;
};

type Dhis2RequestOptions = RequestInit & {
  headers?: HeadersInit;
};

type Dhis2ImportSummary = {
  status?: string;
  description?: string;
  importCount?: {
    imported?: number;
    updated?: number;
    ignored?: number;
    deleted?: number;
  };
  conflicts?: Array<Record<string, unknown>>;
  dataSetComplete?: string | boolean;
};

type Dhis2ErrorPayload = {
  message?: string;
};

type Dhis2SystemInfoPayload = {
  version?: string | null;
  serverDate?: string | null;
  calendar?: string | null;
  revision?: string | null;
};

type Dhis2OrganisationUnitPayload = {
  id?: string | null;
  name?: string | null;
  level?: number | null;
  path?: string | null;
};

type Dhis2MePayload = {
  id?: string | null;
  username?: string | null;
  name?: string | null;
  authorities?: string[];
  organisationUnits?: Dhis2OrganisationUnitPayload[];
  dataViewOrganisationUnits?: Dhis2OrganisationUnitPayload[];
};

type Dhis2CategoryOptionComboPayload = {
  id?: string | null;
  name?: string | null;
};

type Dhis2CategoryComboPayload = {
  id?: string | null;
  name?: string | null;
  categoryOptionCombos?: Dhis2CategoryOptionComboPayload[];
};

type Dhis2DataElementPayload = {
  id?: string | null;
  name?: string | null;
  valueType?: string | null;
  aggregationType?: string | null;
  categoryCombo?: Dhis2CategoryComboPayload | null;
};

type Dhis2DataSetElementPayload = {
  dataElement?: Dhis2DataElementPayload | null;
};

type Dhis2DataSetPayload = {
  id?: string | null;
  name?: string | null;
  periodType?: string | null;
  dataSetElements?: Dhis2DataSetElementPayload[];
};

type Dhis2ImportEnvelope = {
  response?: Dhis2ImportSummary | null;
};

export class Dhis2RequestError extends Error {
  status: number;
  details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'Dhis2RequestError';
    this.status = status;
    this.details = details ?? null;
  }
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export const normalizeDhis2ApiBaseUrl = (value: string) => {
  const trimmed = trimTrailingSlash(String(value || '').trim());
  if (!trimmed) {
    throw new Dhis2RequestError(400, 'DHIS2 base URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Dhis2RequestError(400, 'DHIS2 base URL must be a valid URL');
  }

  const pathname = trimTrailingSlash(parsed.pathname || '');
  const hasApiSuffix = pathname === '/api' || pathname.endsWith('/api');
  const hasApiNestedPath = pathname.startsWith('/api/');

  if (pathname === '' || pathname === '/') {
    parsed.pathname = '/api';
  } else if (hasApiSuffix || hasApiNestedPath) {
    parsed.pathname = pathname;
  } else {
    parsed.pathname = `${pathname}/api`;
  }

  return trimTrailingSlash(parsed.toString());
};

const resolveAuthorizationHeader = (config: Dhis2ConnectionConfig) => {
  if (config.authMode === 'pat') {
    const token = String(config.personalAccessToken || '').trim();
    if (!token) {
      throw new Dhis2RequestError(400, 'DHIS2 personal access token is required');
    }
    return `ApiToken ${token}`;
  }

  const username = String(config.username || '').trim();
  const password = String(config.password || '');
  if (!username || !password) {
    throw new Dhis2RequestError(400, 'DHIS2 username and password are required');
  }

  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
};

const parseDhis2Response = async (response: Response) => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const buildDhis2Url = (baseUrl: string, path: string) => {
  const normalizedBaseUrl = normalizeDhis2ApiBaseUrl(baseUrl);
  return `${normalizedBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
};

const dhis2Request = async (
  config: Dhis2ConnectionConfig,
  path: string,
  options: Dhis2RequestOptions = {}
) => {
  const response = await fetch(buildDhis2Url(config.baseUrl, path), {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: resolveAuthorizationHeader(config),
      ...(options.headers || {}),
    },
  });

  const payload = await parseDhis2Response(response);
  if (!response.ok) {
    const errorPayload = (payload || null) as Dhis2ErrorPayload | null;
    const message =
      typeof errorPayload?.message === 'string' && errorPayload.message.trim()
        ? errorPayload.message.trim()
        : `DHIS2 request failed with status ${response.status}`;
    throw new Dhis2RequestError(response.status, message, payload);
  }

  return payload;
};

export const testDhis2Connection = async (config: Dhis2ConnectionConfig) => {
  const [system, me] = await Promise.all([
    dhis2Request(
      config,
      '/system/info.json?fields=version,serverDate,calendar,revision'
    ),
    dhis2Request(
      config,
      '/me.json?fields=id,username,name,authorities,organisationUnits[id,name,level,path],dataViewOrganisationUnits[id,name,level,path]'
    ),
  ]);
  const systemPayload = (system || null) as Dhis2SystemInfoPayload | null;
  const mePayload = (me || null) as Dhis2MePayload | null;
  const organisationUnits = Array.isArray(mePayload?.dataViewOrganisationUnits)
    ? mePayload.dataViewOrganisationUnits
    : Array.isArray(mePayload?.organisationUnits)
      ? mePayload.organisationUnits
      : [];

  return {
    baseUrl: normalizeDhis2ApiBaseUrl(config.baseUrl),
    system: {
      version: systemPayload?.version || null,
      serverDate: systemPayload?.serverDate || null,
      calendar: systemPayload?.calendar || null,
      revision: systemPayload?.revision || null,
    },
    user: {
      id: mePayload?.id || null,
      username: mePayload?.username || null,
      name: mePayload?.name || null,
      authorities: Array.isArray(mePayload?.authorities) ? mePayload.authorities : [],
    },
    organisationUnits,
  };
};

export const fetchDhis2DataSetMetadata = async (
  config: Dhis2ConnectionConfig,
  dataSetId: string
) => {
  const normalizedId = String(dataSetId || '').trim();
  if (!normalizedId) {
    throw new Dhis2RequestError(400, 'DHIS2 dataset id is required');
  }

  const payload = await dhis2Request(
    config,
    `/dataSets/${encodeURIComponent(normalizedId)}.json?fields=id,name,periodType,dataSetElements[dataElement[id,name,valueType,aggregationType,categoryCombo[id,name,categoryOptionCombos[id,name]]]]`
  );
  const dataSetPayload = (payload || null) as Dhis2DataSetPayload | null;
  const dataSetElements = Array.isArray(dataSetPayload?.dataSetElements)
    ? dataSetPayload.dataSetElements
    : [];

  return {
    id: dataSetPayload?.id || normalizedId,
    name: dataSetPayload?.name || null,
    periodType: dataSetPayload?.periodType || null,
    dataElements: dataSetElements.map((entry) => ({
          id: entry?.dataElement?.id || null,
          name: entry?.dataElement?.name || null,
          valueType: entry?.dataElement?.valueType || null,
          aggregationType: entry?.dataElement?.aggregationType || null,
          categoryCombo: {
            id: entry?.dataElement?.categoryCombo?.id || null,
            name: entry?.dataElement?.categoryCombo?.name || null,
            categoryOptionCombos: Array.isArray(entry?.dataElement?.categoryCombo?.categoryOptionCombos)
              ? entry.dataElement.categoryCombo.categoryOptionCombos.map((combo) => ({
                  id: combo?.id || null,
                  name: combo?.name || null,
                }))
              : [],
          },
        })),
  };
};

const PERIOD_PATTERNS: Record<string, RegExp> = {
  Daily: /^\d{8}$/,
  Weekly: /^\d{4}W\d{2}$/,
  Monthly: /^\d{6}$/,
  Quarterly: /^\d{4}Q[1-4]$/,
  SixMonthly: /^\d{4}S[1-2]$/,
  Yearly: /^\d{4}$/,
};

export const isPeriodCompatibleWithDataSet = (periodType: string | null | undefined, period: string) => {
  const pattern = PERIOD_PATTERNS[String(periodType || '').trim()];
  if (!pattern) return true;
  return pattern.test(String(period || '').trim());
};

export const buildMappedDhis2DataValues = ({
  values,
  mappings,
  orgUnit,
  period,
  comment,
}: {
  values: Record<string, number | string | null | undefined>;
  mappings: Record<string, Dhis2IndicatorMapping>;
  orgUnit: string;
  period: string;
  comment?: string | null;
}) => {
  const normalizedOrgUnit = String(orgUnit || '').trim();
  const normalizedPeriod = String(period || '').trim();

  if (!normalizedOrgUnit) {
    throw new Dhis2RequestError(400, 'DHIS2 organisation unit is required');
  }
  if (!normalizedPeriod) {
    throw new Dhis2RequestError(400, 'DHIS2 period is required');
  }

  const rows: Dhis2SubmissionDataValue[] = [];
  for (const [indicatorCode, mapping] of Object.entries(mappings || {})) {
    const dataElement = String(mapping?.dataElement || '').trim();
    if (!dataElement) continue;

    const rawValue = values?.[indicatorCode];
    const normalizedValue =
      rawValue === null || rawValue === undefined || rawValue === ''
        ? '0'
        : String(rawValue);

    rows.push({
      dataElement,
      period: normalizedPeriod,
      orgUnit: normalizedOrgUnit,
      categoryOptionCombo:
        String(mapping?.categoryOptionCombo || '').trim() || DHIS2_DEFAULT_OPTION_COMBO_UID,
      attributeOptionCombo:
        String(mapping?.attributeOptionCombo || '').trim() || DHIS2_DEFAULT_OPTION_COMBO_UID,
      value: normalizedValue,
      ...(comment ? { comment } : {}),
    });
  }

  if (!rows.length) {
    throw new Dhis2RequestError(400, 'At least one mapped DHIS2 data element is required');
  }

  return rows;
};

export const submitDhis2DataValueSet = async ({
  config,
  dataValues,
  dataSetId,
  completeDate,
  dryRun,
  importStrategy = 'CREATE_AND_UPDATE',
}: {
  config: Dhis2ConnectionConfig;
  dataValues: Dhis2SubmissionDataValue[];
  dataSetId?: string | null;
  completeDate?: string | null;
  dryRun?: boolean;
  importStrategy?: string;
}) => {
  const body: Record<string, unknown> = {
    dataValues,
  };

  if (String(dataSetId || '').trim()) {
    body.dataSet = String(dataSetId).trim();
  }
  if (String(completeDate || '').trim()) {
    body.completeDate = String(completeDate).trim();
  }

  const query = new URLSearchParams({
    dryRun: dryRun ? 'true' : 'false',
    importStrategy,
  });

  const payload = await dhis2Request(config, `/dataValueSets?${query.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return {
    requestBody: body,
    response: payload,
    importSummary: (((payload || null) as Dhis2ImportEnvelope | null)?.response ||
      (payload as Dhis2ImportSummary | null) ||
      null) as Dhis2ImportSummary | null,
  };
};

export const persistDhis2SubmissionRows = async ({
  facilityId,
  tenantId,
  program,
  orgUnit,
  period,
  dataValues,
  batchId,
  dryRun,
  comment,
}: {
  facilityId?: string | null;
  tenantId?: string | null;
  program: string;
  orgUnit: string;
  period: string;
  dataValues: Dhis2SubmissionDataValue[];
  batchId: string;
  dryRun?: boolean;
  comment?: string | null;
}) => {
  const now = new Date().toISOString();
  const rows = dataValues.map((entry) => ({
    data_element_uid: entry.dataElement,
    data_element_name: entry.dataElement,
    category_option_combo_uid: entry.categoryOptionCombo || DHIS2_DEFAULT_OPTION_COMBO_UID,
    org_unit_uid: orgUnit,
    facility_id: facilityId || null,
    tenant_id: tenantId || null,
    period,
    value: entry.value,
    comment: comment || `Link ${program} submission`,
    is_submitted: !dryRun,
    submitted_at: dryRun ? null : now,
    submission_batch: batchId,
  }));

  const { error } = await supabaseAdmin
    .from('dhis2_data_values')
    .upsert(rows, {
      onConflict: 'data_element_uid,category_option_combo_uid,org_unit_uid,period',
    });

  if (error) {
    throw new Dhis2RequestError(500, `Failed to persist DHIS2 submission rows: ${error.message}`, error);
  }

  return rows.length;
};

export const updateFacilityDhis2OrgUnit = async ({
  facilityId,
  tenantId,
  orgUnit,
}: {
  facilityId?: string | null;
  tenantId?: string | null;
  orgUnit?: string | null;
}) => {
  const normalizedFacilityId = String(facilityId || '').trim();
  const normalizedOrgUnit = String(orgUnit || '').trim();
  if (!normalizedFacilityId || !normalizedOrgUnit) return;

  let query = supabaseAdmin
    .from('facilities')
    .update({
      dhis2_org_unit_uid: normalizedOrgUnit,
      updated_at: new Date().toISOString(),
    })
    .eq('id', normalizedFacilityId);

  if (tenantId) {
    query = query.eq('tenant_id', tenantId);
  }

  const { error } = await query;
  if (error) {
    throw new Dhis2RequestError(500, `Failed to update facility DHIS2 org unit: ${error.message}`, error);
  }
};

export const buildSubmissionBatchId = (program: string) => {
  const normalizedProgram = String(program || 'dhis2').trim().toLowerCase() || 'dhis2';
  return `dhis2-${normalizedProgram}-${crypto.randomUUID()}`;
};

export const fetchDhis2DataValues = async ({
  config,
  orgUnit,
  period,
  dataElements,
}: {
  config: Dhis2ConnectionConfig;
  orgUnit: string;
  period: string;
  dataElements: string[];
}) => {
  const query = new URLSearchParams({
    orgUnit: String(orgUnit || '').trim(),
    period: String(period || '').trim(),
    fields: 'dataValues[dataElement,period,orgUnit,categoryOptionCombo,attributeOptionCombo,value,lastUpdated]',
  });

  for (const dataElement of dataElements) {
    const normalized = String(dataElement || '').trim();
    if (!normalized) continue;
    query.append('dataElement', normalized);
  }

  return dhis2Request(config, `/dataValueSets.json?${query.toString()}`);
};
