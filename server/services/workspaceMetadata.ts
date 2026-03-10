export const WORKSPACE_TYPE_VALUES = ['clinic', 'provider'] as const;
export const WORKSPACE_SETUP_MODE_VALUES = ['legacy', 'recommended', 'custom', 'full'] as const;
export const WORKSPACE_TEAM_MODE_VALUES = ['legacy', 'solo', 'small_team', 'full_team'] as const;

export type WorkspaceType = (typeof WORKSPACE_TYPE_VALUES)[number];
export type WorkspaceSetupMode = (typeof WORKSPACE_SETUP_MODE_VALUES)[number];
export type WorkspaceTeamMode = (typeof WORKSPACE_TEAM_MODE_VALUES)[number];

export type WorkspaceMetadata = {
  workspaceType: WorkspaceType;
  setupMode: WorkspaceSetupMode;
  teamMode: WorkspaceTeamMode;
  enabledModules: string[];
};

const defaultWorkspaceMetadata: WorkspaceMetadata = {
  workspaceType: 'clinic',
  setupMode: 'legacy',
  teamMode: 'legacy',
  enabledModules: [],
};

const workspaceTypeSet = new Set<WorkspaceType>(WORKSPACE_TYPE_VALUES);
const setupModeSet = new Set<WorkspaceSetupMode>(WORKSPACE_SETUP_MODE_VALUES);
const teamModeSet = new Set<WorkspaceTeamMode>(WORKSPACE_TEAM_MODE_VALUES);

const normalizeModuleList = (value: unknown) => {
  if (!Array.isArray(value)) return defaultWorkspaceMetadata.enabledModules;
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
};

export const normalizeWorkspaceMetadata = (
  metadata:
    | {
        workspace_type?: unknown;
        setup_mode?: unknown;
        team_mode?: unknown;
        enabled_modules?: unknown;
      }
    | null
    | undefined
): WorkspaceMetadata => {
  const workspaceType =
    typeof metadata?.workspace_type === 'string' && workspaceTypeSet.has(metadata.workspace_type as WorkspaceType)
      ? (metadata.workspace_type as WorkspaceType)
      : defaultWorkspaceMetadata.workspaceType;

  const setupMode =
    typeof metadata?.setup_mode === 'string' && setupModeSet.has(metadata.setup_mode as WorkspaceSetupMode)
      ? (metadata.setup_mode as WorkspaceSetupMode)
      : defaultWorkspaceMetadata.setupMode;

  const teamMode =
    typeof metadata?.team_mode === 'string' && teamModeSet.has(metadata.team_mode as WorkspaceTeamMode)
      ? (metadata.team_mode as WorkspaceTeamMode)
      : defaultWorkspaceMetadata.teamMode;

  return {
    workspaceType,
    setupMode,
    teamMode,
    enabledModules: normalizeModuleList(metadata?.enabled_modules),
  };
};

