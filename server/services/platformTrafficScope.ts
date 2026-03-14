export type PlatformTrafficScope = 'production' | 'all' | 'local';

type PlatformTrafficRow = {
  source?: string | null;
  referrer?: string | null;
  metadata?: Record<string, unknown> | null;
};

const normalizeText = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const normalizeOriginLike = (value: unknown) => {
  const normalized = normalizeText(value);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
};

const getMetadataText = (row: PlatformTrafficRow, key: string) => {
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return '';
  }
  return normalizeText(metadata[key]);
};

const isLocalOrigin = (origin: string) =>
  origin.startsWith('http://localhost') ||
  origin.startsWith('https://localhost') ||
  origin.startsWith('http://127.0.0.1') ||
  origin.startsWith('https://127.0.0.1');

const isProductionOrigin = (origin: string) =>
  origin === 'https://linkhc.org' || origin === 'https://www.linkhc.org';

const isLocalEnvironment = (environment: string) =>
  ['local', 'development', 'dev', 'test'].includes(environment);

const isProductionEnvironment = (environment: string) => environment === 'production';

export const resolvePlatformTrafficScope = (value?: string | null): PlatformTrafficScope => {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'all') return 'all';
  if (normalized === 'local') return 'local';
  return 'production';
};

export const classifyPlatformTraffic = (row: PlatformTrafficRow) => {
  const environment = normalizeText(
    getMetadataText(row, 'environment') || getMetadataText(row, 'deployment_environment')
  ).toLowerCase();
  const appOrigin = normalizeOriginLike(getMetadataText(row, 'app_origin') || getMetadataText(row, 'origin'));
  const referrerOrigin = normalizeOriginLike(row.referrer);

  if (isLocalEnvironment(environment) || isLocalOrigin(appOrigin) || isLocalOrigin(referrerOrigin)) {
    return 'local' as const;
  }

  if (isProductionEnvironment(environment) || isProductionOrigin(appOrigin) || isProductionOrigin(referrerOrigin)) {
    return 'production' as const;
  }

  if (normalizeText(row.source).toLowerCase() === 'external') {
    return 'external' as const;
  }

  return 'production' as const;
};

export const matchesPlatformTrafficScope = (row: PlatformTrafficRow, scope: PlatformTrafficScope) => {
  if (scope === 'all') return true;
  const classification = classifyPlatformTraffic(row);
  if (scope === 'local') return classification === 'local';
  return classification !== 'local';
};
