import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScopedCatalogKey, preferFacilityScopedRows } from '../masterDataCatalog';

test('buildScopedCatalogKey normalizes case and whitespace', () => {
  const key = buildScopedCatalogKey([
    '  Paracetamol  ',
    ' Tablet',
    '500 MG ',
    ' ORAL ',
  ]);

  assert.equal(key, 'paracetamol::tablet::500 mg::oral');
});

test('preferFacilityScopedRows keeps facility override ahead of tenant default', () => {
  const rows = [
    {
      id: 'tenant-default',
      facility_id: null,
      test_code: 'CBC',
      test_name: 'Complete Blood Count',
    },
    {
      id: 'facility-override',
      facility_id: 'facility-1',
      test_code: 'CBC',
      test_name: 'Complete Blood Count',
    },
    {
      id: 'tenant-other',
      facility_id: null,
      test_code: 'LFT',
      test_name: 'Liver Function Tests',
    },
  ];

  const resolved = preferFacilityScopedRows(
    rows,
    (row) => buildScopedCatalogKey([row.test_code])
  );

  assert.deepEqual(
    resolved.map((row) => row.id),
    ['facility-override', 'tenant-other']
  );
});
