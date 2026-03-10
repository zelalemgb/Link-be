-- ============================================================
-- FEAT 28: Workspace Metadata Foundation (Phase 2 / B2.1)
-- ============================================================
-- Adds backward-compatible workspace metadata fields so onboarding
-- can support both clinic and provider self-serve paths without
-- changing existing clinic behavior.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS workspace_type TEXT NOT NULL DEFAULT 'clinic'
    CHECK (workspace_type IN ('clinic', 'provider')),
  ADD COLUMN IF NOT EXISTS setup_mode TEXT NOT NULL DEFAULT 'legacy'
    CHECK (setup_mode IN ('legacy', 'recommended', 'custom', 'full')),
  ADD COLUMN IF NOT EXISTS team_mode TEXT NOT NULL DEFAULT 'legacy'
    CHECK (team_mode IN ('legacy', 'solo', 'small_team', 'full_team')),
  ADD COLUMN IF NOT EXISTS enabled_modules JSONB NOT NULL DEFAULT '[]'::JSONB
    CHECK (jsonb_typeof(enabled_modules) = 'array');

-- Defensive normalization for environments where previous ad-hoc writes
-- may have left nullable or non-array values before this migration.
UPDATE public.tenants
SET
  workspace_type = COALESCE(NULLIF(workspace_type, ''), 'clinic'),
  setup_mode = COALESCE(NULLIF(setup_mode, ''), 'legacy'),
  team_mode = COALESCE(NULLIF(team_mode, ''), 'legacy'),
  enabled_modules = CASE
    WHEN enabled_modules IS NULL THEN '[]'::JSONB
    WHEN jsonb_typeof(enabled_modules) <> 'array' THEN '[]'::JSONB
    ELSE enabled_modules
  END;

