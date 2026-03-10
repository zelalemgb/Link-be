-- ============================================================
-- FEAT 31: Clinic Registration Setup Preferences (Phase 3 / B3.2)
-- ============================================================
-- Stores setup-style choices selected after clinic basics submission
-- so approval and provisioning can align workspace defaults.

ALTER TABLE public.clinic_registrations
  ADD COLUMN IF NOT EXISTS requested_setup_mode TEXT NOT NULL DEFAULT 'recommended'
    CHECK (requested_setup_mode IN ('recommended', 'custom', 'full')),
  ADD COLUMN IF NOT EXISTS requested_modules JSONB NOT NULL DEFAULT '[]'::JSONB
    CHECK (jsonb_typeof(requested_modules) = 'array');

UPDATE public.clinic_registrations
SET
  requested_setup_mode = COALESCE(NULLIF(requested_setup_mode, ''), 'recommended'),
  requested_modules = CASE
    WHEN requested_modules IS NULL THEN '[]'::JSONB
    WHEN jsonb_typeof(requested_modules) <> 'array' THEN '[]'::JSONB
    ELSE requested_modules
  END;
