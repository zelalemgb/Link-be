export type ScopedCatalogRow = {
  id: string;
  facility_id?: string | null;
};

const normalizeCatalogValue = (value: unknown) => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
};

export const buildScopedCatalogKey = (parts: unknown[]) => {
  const normalized = parts.map(normalizeCatalogValue).filter(Boolean);
  return normalized.join('::');
};

export const preferFacilityScopedRows = <T extends ScopedCatalogRow>(
  rows: T[],
  getKey: (row: T) => string
) => {
  const resolved = new Map<string, T>();

  for (const row of [...rows].sort((left, right) => Number(Boolean(right.facility_id)) - Number(Boolean(left.facility_id)))) {
    const key = getKey(row) || row.id;
    if (!resolved.has(key)) {
      resolved.set(key, row);
    }
  }

  return Array.from(resolved.values());
};
