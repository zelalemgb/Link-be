import '../server/config/loadEnv';
import { supabaseAdmin } from '../server/config/supabase';
import { buildScopedCatalogKey } from '../server/services/masterDataCatalog';
import {
  MASTER_SOURCE_URLS,
  TENANT_EQUIPMENT,
  TENANT_IMAGING_STUDIES,
  TENANT_LAB_TESTS,
  TENANT_MEDICAL_SERVICES,
  TENANT_MEDICATIONS,
  TENANT_PROGRAMS,
} from '../server/data/tenantMasterCatalogSeed';

type TenantRow = {
  id: string;
  name: string | null;
};

type UserRow = {
  id: string;
  role: string | null;
  created_at: string;
};

type SeedCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
};

type SeedResult = {
  counts: SeedCounts;
  mode: 'tenant' | 'facility_fallback';
};

type MedicationExistingRow = {
  id: string;
  facility_id: string | null;
  medication_name: string;
  generic_name: string | null;
  dosage_form: string;
  strength: string | null;
  route: string | null;
  category: string;
};

type LabExistingRow = {
  id: string;
  facility_id: string | null;
  test_code: string;
  test_name: string;
  category: string;
  panel_name: string | null;
  unit_of_measure: string;
  sample_type: string;
};

type ServiceExistingRow = {
  id: string;
  facility_id: string | null;
  name: string;
  code: string | null;
  category: string;
  description: string | null;
  price: number;
  follow_up_price: number | null;
  follow_up_days: number | null;
  lab_test_master_id: string | null;
};

type ProgramExistingRow = {
  id: string;
  facility_id: string | null;
  name: string;
  code: string | null;
};

type ImagingExistingRow = {
  id: string;
  facility_id: string | null;
  study_name: string;
  study_code: string | null;
  modality: string;
  body_part: string | null;
};

type EquipmentExistingRow = {
  id: string;
  facility_id: string | null;
  equipment_name: string;
  equipment_code: string | null;
  category: string;
};

const SEED_VERSION = '2026-03-13';
const rolePriority = [
  'super_admin',
  'admin',
  'clinic_admin',
  'hospital_ceo',
  'medical_director',
  'logistic_officer',
  'pharmacist',
  'lab_technician',
  'nursing_head',
];

const requestedTenant = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith('--'))
  ?.trim()
  .toLowerCase();

const stableString = (value: unknown) => JSON.stringify(value ?? null);

const buildMedicationKey = (row: Pick<MedicationExistingRow, 'medication_name' | 'generic_name' | 'dosage_form' | 'strength' | 'route'>) =>
  buildScopedCatalogKey([
    row.medication_name,
    row.generic_name,
    row.dosage_form,
    row.strength,
    row.route,
  ]);

const buildLabKey = (row: Pick<LabExistingRow, 'test_code' | 'test_name'>) =>
  buildScopedCatalogKey([row.test_code || row.test_name]);

const buildServiceKey = (row: Pick<ServiceExistingRow, 'name' | 'code' | 'category'>) =>
  buildScopedCatalogKey([row.code || row.name, row.category]);

const buildProgramKey = (row: Pick<ProgramExistingRow, 'name' | 'code'>) =>
  buildScopedCatalogKey([row.code || row.name]);

const buildImagingKey = (row: Pick<ImagingExistingRow, 'study_name' | 'study_code' | 'modality' | 'body_part'>) =>
  buildScopedCatalogKey([row.study_code || row.study_name, row.modality, row.body_part]);

const buildEquipmentKey = (row: Pick<EquipmentExistingRow, 'equipment_name' | 'equipment_code' | 'category'>) =>
  buildScopedCatalogKey([row.equipment_code || row.equipment_name, row.category]);

const buildSourceMetadata = (sourceKey: keyof typeof MASTER_SOURCE_URLS, sourceLabel: string) => ({
  source_type: 'open_source_reference',
  source_label: sourceLabel,
  source_url: MASTER_SOURCE_URLS[sourceKey],
  curated_baseline: true,
  seeded_version: SEED_VERSION,
});

const inferResultType = (testName: string, unitOfMeasure: string) => {
  const normalizedName = testName.toLowerCase();
  const normalizedUnit = unitOfMeasure.toLowerCase();
  if (normalizedUnit === 'qualitative') return 'qualitative';
  if (
    normalizedName.includes('rapid') ||
    normalizedName.includes('pregnancy') ||
    normalizedName.includes('blood group') ||
    normalizedName.includes('rh')
  ) {
    return 'qualitative';
  }
  return 'quantitative';
};

const selectCreatorUserId = async (tenantId: string) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, role, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to load users for tenant ${tenantId}: ${error.message}`);
  }

  const users = (data || []) as UserRow[];
  if (!users.length) {
    return null;
  }

  users.sort((left, right) => {
    const leftRank = rolePriority.indexOf(left.role || '');
    const rightRank = rolePriority.indexOf(right.role || '');
    const normalizedLeftRank = leftRank === -1 ? rolePriority.length : leftRank;
    const normalizedRightRank = rightRank === -1 ? rolePriority.length : rightRank;
    if (normalizedLeftRank !== normalizedRightRank) {
      return normalizedLeftRank - normalizedRightRank;
    }
    return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
  });

  return users[0]?.id || null;
};

const createEmptyCounts = (): SeedCounts => ({ inserted: 0, updated: 0, unchanged: 0 });

const addCounts = (target: SeedCounts, source: SeedCounts) => {
  target.inserted += source.inserted;
  target.updated += source.updated;
  target.unchanged += source.unchanged;
};

const getTenantFacilities = async (tenantId: string) => {
  const { data, error } = await supabaseAdmin
    .from('facilities')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to read facilities for tenant ${tenantId}: ${error.message}`);
  }

  return (data || []) as Array<{ id: string; name: string | null }>;
};

const upsertMedicationCatalog = async (tenantId: string, createdBy: string | null) => {
  const counts: SeedCounts = { inserted: 0, updated: 0, unchanged: 0 };
  const { data, error } = await supabaseAdmin
    .from('medication_master')
    .select('id, facility_id, medication_name, generic_name, dosage_form, strength, route, category')
    .eq('tenant_id', tenantId)
    .is('facility_id', null);

  if (error) {
    throw new Error(`Failed to read medication catalog: ${error.message}`);
  }

  const existingByKey = new Map(
    ((data || []) as MedicationExistingRow[]).map((row) => [buildMedicationKey(row), row])
  );

  for (const item of TENANT_MEDICATIONS) {
    const key = buildMedicationKey(item);
    const existing = existingByKey.get(key);
    const payload = {
      tenant_id: tenantId,
      facility_id: null,
      created_by: createdBy,
      medication_name: item.medication_name,
      generic_name: item.generic_name,
      dosage_form: item.dosage_form,
      strength: item.strength,
      route: item.route,
      category: item.category,
      is_active: true,
      metadata: buildSourceMetadata('medicines', 'WHO Essential Medicines List'),
    };

    if (!existing) {
      const { error: insertError } = await supabaseAdmin.from('medication_master').insert(payload);
      if (insertError) {
        throw new Error(`Failed to insert medication ${item.medication_name}: ${insertError.message}`);
      }
      counts.inserted += 1;
      continue;
    }

    const comparableExisting = {
      medication_name: existing.medication_name,
      generic_name: existing.generic_name,
      dosage_form: existing.dosage_form,
      strength: existing.strength,
      route: existing.route,
      category: existing.category,
    };

    if (stableString(comparableExisting) === stableString({
      medication_name: item.medication_name,
      generic_name: item.generic_name,
      dosage_form: item.dosage_form,
      strength: item.strength,
      route: item.route,
      category: item.category,
    })) {
      counts.unchanged += 1;
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from('medication_master')
      .update(payload)
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(`Failed to update medication ${item.medication_name}: ${updateError.message}`);
    }
    counts.updated += 1;
  }

  return counts;
};

const upsertLabCatalog = async (tenantId: string, createdBy: string | null) => {
  const counts: SeedCounts = { inserted: 0, updated: 0, unchanged: 0 };
  const { data, error } = await supabaseAdmin
    .from('lab_test_master')
    .select('id, facility_id, test_code, test_name, category, panel_name, unit_of_measure, sample_type')
    .eq('tenant_id', tenantId)
    .is('facility_id', null);

  if (error) {
    throw new Error(`Failed to read lab catalog: ${error.message}`);
  }

  const existingByKey = new Map(
    ((data || []) as LabExistingRow[]).map((row) => [buildLabKey(row), row])
  );
  const catalogByTestName = new Map<string, string>();

  for (const item of TENANT_LAB_TESTS) {
    const key = buildLabKey(item);
    const existing = existingByKey.get(key);
    const payload = {
      tenant_id: tenantId,
      facility_id: null,
      created_by: createdBy,
      test_code: item.test_code,
      test_name: item.test_name,
      category: item.category,
      panel_name: item.panel_name,
      reference_range_general: item.reference_range_general || null,
      unit_of_measure: item.unit_of_measure,
      sample_type: item.sample_type,
      turnaround_time_hours: item.turnaround_time_hours,
      result_type: inferResultType(item.test_name, item.unit_of_measure),
      qualitative_options: inferResultType(item.test_name, item.unit_of_measure) === 'qualitative' ? ['Positive', 'Negative'] : null,
      is_active: true,
      metadata: buildSourceMetadata('diagnostics', 'WHO Essential Diagnostics List'),
    };

    if (!existing) {
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('lab_test_master')
        .insert(payload)
        .select('id, test_name')
        .single();

      if (insertError) {
        throw new Error(`Failed to insert lab test ${item.test_name}: ${insertError.message}`);
      }
      if (inserted?.id) {
        catalogByTestName.set(item.test_name.toLowerCase(), inserted.id);
      }
      counts.inserted += 1;
      continue;
    }

    catalogByTestName.set(item.test_name.toLowerCase(), existing.id);

    const comparableExisting = {
      test_code: existing.test_code,
      test_name: existing.test_name,
      category: existing.category,
      panel_name: existing.panel_name,
      unit_of_measure: existing.unit_of_measure,
      sample_type: existing.sample_type,
    };

    if (stableString(comparableExisting) === stableString({
      test_code: item.test_code,
      test_name: item.test_name,
      category: item.category,
      panel_name: item.panel_name,
      unit_of_measure: item.unit_of_measure,
      sample_type: item.sample_type,
    })) {
      counts.unchanged += 1;
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from('lab_test_master')
      .update(payload)
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(`Failed to update lab test ${item.test_name}: ${updateError.message}`);
    }
    counts.updated += 1;
  }

  return { counts, catalogByTestName };
};

const upsertMedicalServicesAtScope = async (
  tenantId: string,
  facilityId: string | null,
  createdBy: string | null,
  labCatalogByName: Map<string, string>
) => {
  const counts: SeedCounts = { inserted: 0, updated: 0, unchanged: 0 };
  let query = supabaseAdmin
    .from('medical_services')
    .select('id, facility_id, name, code, category, description, price, follow_up_price, follow_up_days, lab_test_master_id')
    .eq('tenant_id', tenantId);

  query = facilityId ? query.eq('facility_id', facilityId) : query.is('facility_id', null);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to read medical services: ${error.message}`);
  }

  const existingByKey = new Map(
    ((data || []) as ServiceExistingRow[]).map((row) => [buildServiceKey(row), row])
  );

  for (const item of TENANT_MEDICAL_SERVICES) {
    const key = buildServiceKey(item);
    const existing = existingByKey.get(key);
    const linkedLabTestId =
      item.category === 'Laboratory'
        ? labCatalogByName.get(item.name.toLowerCase()) || null
        : null;

    const payload = {
      tenant_id: tenantId,
      facility_id: facilityId,
      created_by: createdBy,
      name: item.name,
      code: item.code,
      category: item.category,
      description: item.description,
      price: item.price,
      follow_up_price: item.follow_up_price,
      follow_up_days: item.follow_up_days,
      lab_test_master_id: linkedLabTestId,
      is_active: true,
    };

    if (!existing) {
      const { error: insertError } = await supabaseAdmin.from('medical_services').insert(payload);
      if (insertError) {
        throw new Error(`Failed to insert medical service ${item.name}: ${insertError.message}`);
      }
      counts.inserted += 1;
      continue;
    }

    const comparableExisting = {
      name: existing.name,
      code: existing.code,
      category: existing.category,
      description: existing.description,
      price: existing.price,
      follow_up_price: existing.follow_up_price,
      follow_up_days: existing.follow_up_days,
      lab_test_master_id: existing.lab_test_master_id,
    };

    if (stableString(comparableExisting) === stableString({
      name: item.name,
      code: item.code,
      category: item.category,
      description: item.description,
      price: item.price,
      follow_up_price: item.follow_up_price,
      follow_up_days: item.follow_up_days,
      lab_test_master_id: linkedLabTestId,
    })) {
      counts.unchanged += 1;
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from('medical_services')
      .update(payload)
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(`Failed to update medical service ${item.name}: ${updateError.message}`);
    }
    counts.updated += 1;
  }

  return counts;
};

const upsertMedicalServices = async (
  tenantId: string,
  createdBy: string | null,
  labCatalogByName: Map<string, string>
): Promise<SeedResult> => {
  try {
    return {
      counts: await upsertMedicalServicesAtScope(tenantId, null, createdBy, labCatalogByName),
      mode: 'tenant',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('null value in column "facility_id"')) {
      throw error;
    }

    const facilities = await getTenantFacilities(tenantId);
    if (!facilities.length) {
      return {
        counts: createEmptyCounts(),
        mode: 'facility_fallback',
      };
    }

    const aggregate = createEmptyCounts();
    for (const facility of facilities) {
      const counts = await upsertMedicalServicesAtScope(tenantId, facility.id, createdBy, labCatalogByName);
      addCounts(aggregate, counts);
    }

    return {
      counts: aggregate,
      mode: 'facility_fallback',
    };
  }
};

const upsertPrograms = async (tenantId: string, createdBy: string | null) => {
  const counts: SeedCounts = { inserted: 0, updated: 0, unchanged: 0 };
  const { data, error } = await supabaseAdmin
    .from('programs')
    .select('id, facility_id, name, code')
    .eq('tenant_id', tenantId)
    .is('facility_id', null);

  if (error) {
    throw new Error(`Failed to read programs: ${error.message}`);
  }

  const existingByKey = new Map(
    ((data || []) as ProgramExistingRow[]).map((row) => [buildProgramKey(row), row])
  );

  for (const item of TENANT_PROGRAMS) {
    const key = buildProgramKey(item);
    const existing = existingByKey.get(key);
    const payload = {
      tenant_id: tenantId,
      facility_id: null,
      created_by: createdBy,
      name: item.name,
      code: item.code,
      is_active: true,
    };

    if (!existing) {
      const { error: insertError } = await supabaseAdmin.from('programs').insert(payload);
      if (insertError) {
        throw new Error(`Failed to insert program ${item.name}: ${insertError.message}`);
      }
      counts.inserted += 1;
      continue;
    }

    if (stableString({ name: existing.name, code: existing.code }) === stableString(item)) {
      counts.unchanged += 1;
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from('programs')
      .update(payload)
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(`Failed to update program ${item.name}: ${updateError.message}`);
    }
    counts.updated += 1;
  }

  return counts;
};

const upsertImagingCatalog = async (tenantId: string, createdBy: string | null) => {
  const counts: SeedCounts = { inserted: 0, updated: 0, unchanged: 0 };
  const { data, error } = await supabaseAdmin
    .from('imaging_study_catalog')
    .select('id, facility_id, study_name, study_code, modality, body_part')
    .eq('tenant_id', tenantId)
    .is('facility_id', null);

  if (error) {
    throw new Error(`Failed to read imaging catalog: ${error.message}`);
  }

  const existingByKey = new Map(
    ((data || []) as ImagingExistingRow[]).map((row) => [buildImagingKey(row), row])
  );

  for (const item of TENANT_IMAGING_STUDIES) {
    const key = buildImagingKey(item);
    const existing = existingByKey.get(key);
    const payload = {
      tenant_id: tenantId,
      facility_id: null,
      created_by: createdBy,
      study_name: item.study_name,
      study_code: item.study_code,
      modality: item.modality,
      body_part: item.body_part,
      description: item.description,
      preparation_instructions: item.preparation_instructions,
      estimated_duration_minutes: item.estimated_duration_minutes,
      price: item.price,
      is_active: true,
    };

    if (!existing) {
      const { error: insertError } = await supabaseAdmin.from('imaging_study_catalog').insert(payload);
      if (insertError) {
        throw new Error(`Failed to insert imaging study ${item.study_name}: ${insertError.message}`);
      }
      counts.inserted += 1;
      continue;
    }

    const comparableExisting = {
      study_name: existing.study_name,
      study_code: existing.study_code,
      modality: existing.modality,
      body_part: existing.body_part,
    };

    if (stableString(comparableExisting) === stableString({
      study_name: item.study_name,
      study_code: item.study_code,
      modality: item.modality,
      body_part: item.body_part,
    })) {
      counts.unchanged += 1;
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from('imaging_study_catalog')
      .update(payload)
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(`Failed to update imaging study ${item.study_name}: ${updateError.message}`);
    }
    counts.updated += 1;
  }

  return counts;
};

const upsertEquipmentCatalog = async (tenantId: string, createdBy: string | null) => {
  const counts: SeedCounts = { inserted: 0, updated: 0, unchanged: 0 };
  const { data, error } = await supabaseAdmin
    .from('equipment_master')
    .select('id, facility_id, equipment_name, equipment_code, category')
    .eq('tenant_id', tenantId)
    .is('facility_id', null);

  if (error) {
    throw new Error(`Failed to read equipment catalog: ${error.message}`);
  }

  const existingByKey = new Map(
    ((data || []) as EquipmentExistingRow[]).map((row) => [buildEquipmentKey(row), row])
  );

  for (const item of TENANT_EQUIPMENT) {
    const key = buildEquipmentKey(item);
    const existing = existingByKey.get(key);
    const payload = {
      tenant_id: tenantId,
      facility_id: null,
      created_by: createdBy,
      equipment_name: item.equipment_name,
      equipment_code: item.equipment_code,
      category: item.category,
      unit_of_measure: item.unit_of_measure,
      manufacturer: item.manufacturer,
      model_number: item.model_number,
      description: item.description,
      is_active: true,
      metadata: buildSourceMetadata('devices', 'WHO priority medical devices guidance'),
    };

    if (!existing) {
      const { error: insertError } = await supabaseAdmin.from('equipment_master').insert(payload);
      if (insertError) {
        throw new Error(`Failed to insert equipment ${item.equipment_name}: ${insertError.message}`);
      }
      counts.inserted += 1;
      continue;
    }

    const comparableExisting = {
      equipment_name: existing.equipment_name,
      equipment_code: existing.equipment_code,
      category: existing.category,
    };

    if (stableString(comparableExisting) === stableString({
      equipment_name: item.equipment_name,
      equipment_code: item.equipment_code,
      category: item.category,
    })) {
      counts.unchanged += 1;
      continue;
    }

    const { error: updateError } = await supabaseAdmin
      .from('equipment_master')
      .update(payload)
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(`Failed to update equipment ${item.equipment_name}: ${updateError.message}`);
    }
    counts.updated += 1;
  }

  return counts;
};

const filterTenants = (tenants: TenantRow[]) => {
  if (!requestedTenant) {
    return tenants;
  }

  return tenants.filter((tenant) => {
    const idMatch = tenant.id.toLowerCase() === requestedTenant;
    const nameMatch = (tenant.name || '').toLowerCase().includes(requestedTenant);
    return idMatch || nameMatch;
  });
};

async function main() {
  const { data, error } = await supabaseAdmin
    .from('tenants')
    .select('id, name')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to read tenants: ${error.message}`);
  }

  const tenants = filterTenants((data || []) as TenantRow[]);
  if (!tenants.length) {
    throw new Error(requestedTenant ? `No tenant matched "${requestedTenant}".` : 'No tenants found.');
  }

  process.stdout.write(`Seeding tenant-wide master catalogs (${SEED_VERSION})\n`);
  process.stdout.write(`Sources:\n`);
  Object.entries(MASTER_SOURCE_URLS).forEach(([key, value]) => {
    process.stdout.write(`- ${key}: ${value}\n`);
  });

  for (const tenant of tenants) {
    const createdBy = await selectCreatorUserId(tenant.id);
    if (!createdBy) {
      process.stdout.write(`\nTenant: ${tenant.name || tenant.id}\n`);
      process.stdout.write('  skipped: no users available to attribute created_by fields\n');
      continue;
    }
    process.stdout.write(`\nTenant: ${tenant.name || tenant.id}\n`);

    const medicationCounts = await upsertMedicationCatalog(tenant.id, createdBy);
    const labResult = await upsertLabCatalog(tenant.id, createdBy);
    const serviceResult = await upsertMedicalServices(tenant.id, createdBy, labResult.catalogByTestName);
    const programCounts = await upsertPrograms(tenant.id, createdBy);
    const imagingCounts = await upsertImagingCatalog(tenant.id, createdBy);
    const equipmentCounts = await upsertEquipmentCatalog(tenant.id, createdBy);

    const summaryRows = [
      ['medication_master', medicationCounts],
      ['lab_test_master', labResult.counts],
      [`medical_services (${serviceResult.mode})`, serviceResult.counts],
      ['programs', programCounts],
      ['imaging_study_catalog', imagingCounts],
      ['equipment_master', equipmentCounts],
    ] as const;

    for (const [label, counts] of summaryRows) {
      process.stdout.write(
        `  ${label}: inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged}\n`
      );
    }
  }

  process.stdout.write('\nTenant-wide master catalog seed complete.\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
