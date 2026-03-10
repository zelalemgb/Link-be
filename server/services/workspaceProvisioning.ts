import { supabaseAdmin } from '../config/supabase';
import {
  normalizeWorkspaceMetadata,
  type WorkspaceMetadata,
  type WorkspaceSetupMode,
  type WorkspaceTeamMode,
  type WorkspaceType,
} from './workspaceMetadata';

const WORKSPACE_CORE_MODULES = [
  'patients',
  'visits',
  'records',
  'referrals',
  'follow_up',
  'link_agent',
  'cdss_core',
];

const WORKSPACE_COMMON_MODULES = [
  'reception',
  'triage',
  'cashier',
  'lab',
  'imaging',
  'pharmacy',
  'patient_app_sync',
  'hew_referral_handoff',
];

const WORKSPACE_ADVANCED_MODULES = [
  'inventory',
  'inpatient',
  'analytics',
  'multi_facility',
  'public_health',
  'cdss_advanced',
];

const DEFAULT_INSURERS = [
  { name: 'Ethiopian Health Insurance Agency (EHIA)', code: 'EHIA' },
  { name: 'Community Based Health Insurance (CBHI)', code: 'CBHI' },
  { name: 'Cash Payment', code: 'CASH' },
  { name: 'Free/Waiver', code: 'FREE' },
];

const DEFAULT_CONSULTATION_SERVICES = [
  {
    name: 'New Patient Consultation',
    code: 'CONS-NEW',
    category: 'Consultation',
    description: 'Initial consultation for new patients',
    price: 200,
  },
  {
    name: 'Follow-up Consultation',
    code: 'CONS-FOLLOWUP',
    category: 'Consultation',
    description: 'Follow-up visit consultation',
    price: 100,
    follow_up_price: 100,
    follow_up_days: 10,
  },
  {
    name: 'Returning Patient Consultation',
    code: 'CONS-RETURNING',
    category: 'Consultation',
    description: 'Consultation for returning patients',
    price: 150,
  },
  {
    name: 'Emergency Consultation',
    code: 'CONS-EMERGENCY',
    category: 'Consultation',
    description: 'Emergency consultation service',
    price: 300,
  },
];

const normalizeModuleName = (value: string) => value.trim().toLowerCase();

const uniqueModules = (values: string[]) => {
  const modules = new Set<string>();
  for (const value of values) {
    const normalized = normalizeModuleName(value);
    if (!normalized) continue;
    modules.add(normalized);
  }
  return Array.from(modules);
};

const modulesForSetupMode = (setupMode: WorkspaceSetupMode) => {
  const coreModules = [...WORKSPACE_CORE_MODULES];
  const commonModules = [...WORKSPACE_COMMON_MODULES];
  const advancedModules = [...WORKSPACE_ADVANCED_MODULES];

  if (setupMode === 'full') {
    return uniqueModules([...coreModules, ...commonModules, ...advancedModules]);
  }

  if (setupMode === 'recommended') {
    return uniqueModules([...coreModules, ...commonModules]);
  }

  if (setupMode === 'custom') {
    return uniqueModules([...coreModules]);
  }

  return uniqueModules(coreModules);
};

export const resolveWorkspaceModules = (setupMode: WorkspaceSetupMode, existingModules: string[]) =>
  uniqueModules([...modulesForSetupMode(setupMode), ...(existingModules || [])]);

const normalizeModeForProvisioning = (mode: WorkspaceSetupMode | undefined, fallback: WorkspaceSetupMode) =>
  mode && mode !== 'legacy' ? mode : fallback;

const normalizeTeamForProvisioning = (mode: WorkspaceTeamMode | undefined, fallback: WorkspaceTeamMode) =>
  mode && mode !== 'legacy' ? mode : fallback;

type WorkspaceProvisioningInput = {
  tenantId: string;
  facilityId: string;
  userId: string;
  workspaceType?: WorkspaceType;
  setupMode?: WorkspaceSetupMode;
  teamMode?: WorkspaceTeamMode;
};

type WorkspaceProvisioningResult = {
  workspace: WorkspaceMetadata;
  metadataUpdated: boolean;
  created: {
    departments: number;
    insurers: number;
    services: number;
  };
};

type WorkspaceProvisioningProfileInput = {
  workspaceType?: WorkspaceType;
  setupMode?: WorkspaceSetupMode;
  teamMode?: WorkspaceTeamMode;
};

export const resolveWorkspaceProvisioningProfile = (
  input: WorkspaceProvisioningProfileInput = {}
) => {
  const workspaceType = input.workspaceType || 'clinic';
  const setupModeFallback: WorkspaceSetupMode = 'recommended';
  const teamModeFallback: WorkspaceTeamMode = 'solo';

  const setupMode = normalizeModeForProvisioning(input.setupMode, setupModeFallback);
  const teamMode = normalizeTeamForProvisioning(input.teamMode, teamModeFallback);

  return {
    workspaceType,
    setupMode,
    teamMode,
    enabledModules: modulesForSetupMode(setupMode),
  };
};

const mergeWorkspaceMetadata = (
  current: WorkspaceMetadata,
  workspaceType: WorkspaceType,
  setupMode: WorkspaceSetupMode,
  teamMode: WorkspaceTeamMode
) => {
  const mergedSetupMode = current.setupMode === 'legacy' ? setupMode : current.setupMode;
  const mergedTeamMode = current.teamMode === 'legacy' ? teamMode : current.teamMode;
  return {
    workspaceType,
    setupMode: mergedSetupMode,
    teamMode: mergedTeamMode,
    enabledModules: resolveWorkspaceModules(mergedSetupMode, current.enabledModules),
  };
};

const toModuleList = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const modulesMatch = (a: unknown, b: unknown) => {
  const normalizedA = uniqueModules(toModuleList(a));
  const normalizedB = uniqueModules(toModuleList(b));
  if (normalizedA.length !== normalizedB.length) return false;

  const right = new Set(normalizedB);
  return normalizedA.every((value) => right.has(value));
};

export const provisionWorkspaceDefaults = async (
  input: WorkspaceProvisioningInput
): Promise<WorkspaceProvisioningResult> => {
  const { tenantId, facilityId, userId } = input;
  const requestedProfile = resolveWorkspaceProvisioningProfile({
    workspaceType: input.workspaceType,
    setupMode: input.setupMode,
    teamMode: input.teamMode,
  });

  const { data: tenantRow, error: tenantError } = await supabaseAdmin
    .from('tenants')
    .select('id, workspace_type, setup_mode, team_mode, enabled_modules')
    .eq('id', tenantId)
    .maybeSingle();

  if (tenantError) throw tenantError;
  if (!tenantRow) {
    throw new Error('Tenant not found for workspace provisioning');
  }

  const currentWorkspace = normalizeWorkspaceMetadata(tenantRow as any);
  const nextWorkspace = mergeWorkspaceMetadata(
    currentWorkspace,
    requestedProfile.workspaceType,
    requestedProfile.setupMode,
    requestedProfile.teamMode
  );

  const metadataChanged =
    (tenantRow.workspace_type || null) !== nextWorkspace.workspaceType ||
    (tenantRow.setup_mode || null) !== nextWorkspace.setupMode ||
    (tenantRow.team_mode || null) !== nextWorkspace.teamMode ||
    !modulesMatch(tenantRow.enabled_modules, nextWorkspace.enabledModules);

  if (metadataChanged) {
    const { error: updateTenantError } = await supabaseAdmin
      .from('tenants')
      .update({
        workspace_type: nextWorkspace.workspaceType,
        setup_mode: nextWorkspace.setupMode,
        team_mode: nextWorkspace.teamMode,
        enabled_modules: nextWorkspace.enabledModules,
      })
      .eq('id', tenantId);

    if (updateTenantError) throw updateTenantError;
  }

  const created = {
    departments: 0,
    insurers: 0,
    services: 0,
  };

  const { count: departmentCount, error: departmentCountError } = await supabaseAdmin
    .from('departments')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('facility_id', facilityId)
    .eq('is_active', true);

  if (departmentCountError) throw departmentCountError;

  if ((departmentCount || 0) === 0) {
    const { error: departmentInsertError } = await supabaseAdmin.from('departments').insert({
      tenant_id: tenantId,
      facility_id: facilityId,
      name: 'Outpatient Department',
      code: null,
      department_type: 'outpatient',
      is_active: true,
      total_beds: 0,
      available_beds: 0,
      occupied_beds: 0,
    });

    if (departmentInsertError) throw departmentInsertError;
    created.departments = 1;
  }

  const { data: insurers, error: insurersError } = await supabaseAdmin
    .from('insurers')
    .select('name, code')
    .eq('tenant_id', tenantId)
    .eq('facility_id', facilityId)
    .eq('is_active', true);

  if (insurersError) throw insurersError;

  const existingInsurerNames = new Set(
    (insurers || [])
      .map((row: any) => (typeof row.name === 'string' ? row.name.trim().toLowerCase() : ''))
      .filter(Boolean)
  );
  const existingInsurerCodes = new Set(
    (insurers || [])
      .map((row: any) => (typeof row.code === 'string' ? row.code.trim().toLowerCase() : ''))
      .filter(Boolean)
  );

  const insurersToInsert = DEFAULT_INSURERS.filter((insurer) => {
    const normalizedName = insurer.name.trim().toLowerCase();
    const normalizedCode = insurer.code.trim().toLowerCase();
    return !existingInsurerNames.has(normalizedName) && !existingInsurerCodes.has(normalizedCode);
  }).map((insurer) => ({
    tenant_id: tenantId,
    facility_id: facilityId,
    name: insurer.name,
    code: insurer.code,
    is_active: true,
    created_by: userId,
  }));

  if (insurersToInsert.length > 0) {
    const { error: insertInsurersError } = await supabaseAdmin.from('insurers').insert(insurersToInsert);
    if (insertInsurersError) throw insertInsurersError;
    created.insurers = insurersToInsert.length;
  }

  const { data: consultationServices, error: consultationServicesError } = await supabaseAdmin
    .from('medical_services')
    .select('name')
    .eq('tenant_id', tenantId)
    .eq('facility_id', facilityId)
    .eq('category', 'Consultation')
    .eq('is_active', true);

  if (consultationServicesError) throw consultationServicesError;

  const existingServiceNames = new Set(
    (consultationServices || [])
      .map((row: any) => (typeof row.name === 'string' ? row.name.trim().toLowerCase() : ''))
      .filter(Boolean)
  );

  const servicesToInsert = DEFAULT_CONSULTATION_SERVICES.filter(
    (service) => !existingServiceNames.has(service.name.trim().toLowerCase())
  ).map((service) => ({
    ...service,
    tenant_id: tenantId,
    facility_id: facilityId,
    is_active: true,
    created_by: userId,
  }));

  if (servicesToInsert.length > 0) {
    const { error: insertServicesError } = await supabaseAdmin.from('medical_services').insert(servicesToInsert);
    if (insertServicesError) throw insertServicesError;
    created.services = servicesToInsert.length;
  }

  return {
    workspace: nextWorkspace,
    metadataUpdated: metadataChanged,
    created,
  };
};

export const __testables = {
  WORKSPACE_CORE_MODULES,
  WORKSPACE_COMMON_MODULES,
  WORKSPACE_ADVANCED_MODULES,
  modulesForSetupMode,
  resolveWorkspaceModules,
  resolveWorkspaceProvisioningProfile,
};
