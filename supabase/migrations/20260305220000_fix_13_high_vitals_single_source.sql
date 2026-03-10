-- ============================================================
-- FIX 13 — HIGH: Vitals Single Source of Truth
-- ============================================================
-- Problem:
--   Vital signs are stored in three separate places with no sync:
--   1. Legacy columns on visits: temperature, weight, blood_pressure (TEXT/FLOAT)
--   2. JSONB snapshot: visits.vitals_json
--   3. Normalised rows: public.observations (FHIR Observation, FIX 09)
--   A vital recorded via the observations table will not appear in
--   vitals_json, and vice versa.
--
-- Fix:
--   1. Designate observations as the single source of truth (SoT).
--   2. Add trigger on observations INSERT/UPDATE/DELETE that rebuilds
--      visits.vitals_json from all current observations for that visit.
--   3. Back-fill observations from visits.vitals_json for historical rows.
--   4. Deprecation comments on the three legacy columns.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- 0. Ensure visits.vitals_json column exists.
--    It is the denormalised JSONB cache rebuilt by the trigger below.
--    If the remote schema never had this column, create it now.
-- ══════════════════════════════════════════════
ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS vitals_json JSONB;

COMMENT ON COLUMN public.visits.vitals_json IS
  'Denormalised JSONB cache of the most recent vital-sign observations '
  'for this visit. Rebuilt automatically by trg_sync_vitals_json. '
  'Source of truth is the observations table; this column is a derived cache '
  'kept for mobile offline-sync reads.';

-- ══════════════════════════════════════════════
-- 1. Trigger function: rebuild vitals_json from observations
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.sync_vitals_json_from_observations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_visit_id UUID;
  v_vitals   JSONB;
BEGIN
  -- Determine the affected visit
  IF TG_OP = 'DELETE' THEN
    v_visit_id := OLD.visit_id;
  ELSE
    v_visit_id := NEW.visit_id;
  END IF;

  -- Rebuild the JSONB snapshot by pivoting key LOINC codes
  -- LOINC reference: 8310-5=temp, 29463-7=weight, 8302-2=height,
  --   55284-4=bp (systolic 8480-6, diastolic 8462-4), 8867-4=hr,
  --   59408-5=SpO2, 56115-2=MUAC
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'temp',          MAX(o.value_numeric) FILTER (WHERE o.loinc_code = '8310-5'),
    'weight_kg',     MAX(o.value_numeric) FILTER (WHERE o.loinc_code = '29463-7'),
    'height_cm',     MAX(o.value_numeric) FILTER (WHERE o.loinc_code = '8302-2'),
    'bp_systolic',   MAX(o.value_numeric) FILTER (WHERE o.loinc_code = '8480-6'),
    'bp_diastolic',  MAX(o.value_numeric) FILTER (WHERE o.loinc_code = '8462-4'),
    'hr',            MAX(o.value_numeric) FILTER (WHERE o.loinc_code = '8867-4'),
    'spo2',          MAX(o.value_numeric) FILTER (WHERE o.loinc_code = '59408-5'),
    'muac_mm',       MAX(o.value_numeric) FILTER (WHERE o.loinc_code = '56115-2'),
    'recorded_at',   MAX(o.observed_at)::TEXT
  ))
  INTO v_vitals
  FROM public.observations o
  WHERE o.visit_id = v_visit_id
    AND o.status   NOT IN ('cancelled')
    AND o.loinc_code IN (
      '8310-5','29463-7','8302-2','8480-6','8462-4','8867-4','59408-5','56115-2'
    );

  -- Update visits.vitals_json if the column exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'visits'
      AND column_name = 'vitals_json'
  ) THEN
    UPDATE public.visits
    SET vitals_json = COALESCE(v_vitals, '{}'::jsonb),
        updated_at  = now()
    WHERE id = v_visit_id;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_vitals_json_from_observations failed: % %', SQLSTATE, SQLERRM;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_vitals_json_from_observations() IS
  'AFTER trigger on observations. Rebuilds visits.vitals_json as a '
  'denormalised JSONB snapshot for mobile sync. '
  'observations is the authoritative source; vitals_json is a derived cache.';

DROP TRIGGER IF EXISTS trg_sync_vitals_json ON public.observations;

CREATE TRIGGER trg_sync_vitals_json
  AFTER INSERT OR UPDATE OR DELETE ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_vitals_json_from_observations();

-- ══════════════════════════════════════════════
-- 2. Back-fill observations from visits.vitals_json
--    (idempotent: skips visits already having observations)
-- ══════════════════════════════════════════════
DO $$
DECLARE
  v_vitals_col_exists BOOLEAN;
  v_inserted          INTEGER := 0;
  v_rec               RECORD;
  v_created_by        UUID;
BEGIN
  -- Check column exists
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'visits'
      AND column_name = 'vitals_json'
  ) INTO v_vitals_col_exists;

  IF NOT v_vitals_col_exists THEN
    RAISE NOTICE 'visits.vitals_json does not exist — skipping back-fill.';
    RETURN;
  END IF;

  FOR v_rec IN
    SELECT
      v.id           AS visit_id,
      v.patient_id,
      v.tenant_id,
      v.facility_id,
      v.vitals_json,
      v.created_by,
      v.visit_date
    FROM public.visits v
    WHERE v.vitals_json IS NOT NULL
      AND v.vitals_json <> '{}'::jsonb
      -- Only back-fill visits that have no observations yet
      AND NOT EXISTS (
        SELECT 1 FROM public.observations o WHERE o.visit_id = v.id
      )
  LOOP
    v_created_by := COALESCE(v_rec.created_by,
      (SELECT id FROM public.users ORDER BY created_at LIMIT 1));

    -- temperature
    IF (v_rec.vitals_json->>'temp') IS NOT NULL THEN
      INSERT INTO public.observations (
        tenant_id, facility_id, visit_id, patient_id,
        loinc_code, display_name,
        value_numeric, unit, status, observed_at
      ) VALUES (
        v_rec.tenant_id, v_rec.facility_id, v_rec.visit_id, v_rec.patient_id,
        '8310-5', 'Body Temperature',
        (v_rec.vitals_json->>'temp')::NUMERIC, 'Cel', 'final',
        COALESCE(v_rec.visit_date::TIMESTAMPTZ, now())
      ) ON CONFLICT DO NOTHING;
      v_inserted := v_inserted + 1;
    END IF;

    -- weight
    IF (v_rec.vitals_json->>'weight_kg') IS NOT NULL THEN
      INSERT INTO public.observations (
        tenant_id, facility_id, visit_id, patient_id,
        loinc_code, display_name,
        value_numeric, unit, status, observed_at
      ) VALUES (
        v_rec.tenant_id, v_rec.facility_id, v_rec.visit_id, v_rec.patient_id,
        '29463-7', 'Body Weight',
        (v_rec.vitals_json->>'weight_kg')::NUMERIC, 'kg', 'final',
        COALESCE(v_rec.visit_date::TIMESTAMPTZ, now())
      ) ON CONFLICT DO NOTHING;
      v_inserted := v_inserted + 1;
    END IF;

    -- height
    IF (v_rec.vitals_json->>'height_cm') IS NOT NULL THEN
      INSERT INTO public.observations (
        tenant_id, facility_id, visit_id, patient_id,
        loinc_code, display_name,
        value_numeric, unit, status, observed_at
      ) VALUES (
        v_rec.tenant_id, v_rec.facility_id, v_rec.visit_id, v_rec.patient_id,
        '8302-2', 'Body Height',
        (v_rec.vitals_json->>'height_cm')::NUMERIC, 'cm', 'final',
        COALESCE(v_rec.visit_date::TIMESTAMPTZ, now())
      ) ON CONFLICT DO NOTHING;
      v_inserted := v_inserted + 1;
    END IF;

    -- BP systolic
    IF (v_rec.vitals_json->>'bp_systolic') IS NOT NULL THEN
      INSERT INTO public.observations (
        tenant_id, facility_id, visit_id, patient_id,
        loinc_code, display_name,
        value_numeric, unit, status, observed_at
      ) VALUES (
        v_rec.tenant_id, v_rec.facility_id, v_rec.visit_id, v_rec.patient_id,
        '8480-6', 'Systolic Blood Pressure',
        (v_rec.vitals_json->>'bp_systolic')::NUMERIC, 'mm[Hg]', 'final',
        COALESCE(v_rec.visit_date::TIMESTAMPTZ, now())
      ) ON CONFLICT DO NOTHING;
      v_inserted := v_inserted + 1;
    END IF;

    -- BP diastolic
    IF (v_rec.vitals_json->>'bp_diastolic') IS NOT NULL THEN
      INSERT INTO public.observations (
        tenant_id, facility_id, visit_id, patient_id,
        loinc_code, display_name,
        value_numeric, unit, status, observed_at
      ) VALUES (
        v_rec.tenant_id, v_rec.facility_id, v_rec.visit_id, v_rec.patient_id,
        '8462-4', 'Diastolic Blood Pressure',
        (v_rec.vitals_json->>'bp_diastolic')::NUMERIC, 'mm[Hg]', 'final',
        COALESCE(v_rec.visit_date::TIMESTAMPTZ, now())
      ) ON CONFLICT DO NOTHING;
      v_inserted := v_inserted + 1;
    END IF;

    -- Heart rate
    IF (v_rec.vitals_json->>'hr') IS NOT NULL THEN
      INSERT INTO public.observations (
        tenant_id, facility_id, visit_id, patient_id,
        loinc_code, display_name,
        value_numeric, unit, status, observed_at
      ) VALUES (
        v_rec.tenant_id, v_rec.facility_id, v_rec.visit_id, v_rec.patient_id,
        '8867-4', 'Heart Rate',
        (v_rec.vitals_json->>'hr')::NUMERIC, '/min', 'final',
        COALESCE(v_rec.visit_date::TIMESTAMPTZ, now())
      ) ON CONFLICT DO NOTHING;
      v_inserted := v_inserted + 1;
    END IF;

    -- SpO2
    IF (v_rec.vitals_json->>'spo2') IS NOT NULL THEN
      INSERT INTO public.observations (
        tenant_id, facility_id, visit_id, patient_id,
        loinc_code, display_name,
        value_numeric, unit, status, observed_at
      ) VALUES (
        v_rec.tenant_id, v_rec.facility_id, v_rec.visit_id, v_rec.patient_id,
        '59408-5', 'Oxygen Saturation',
        (v_rec.vitals_json->>'spo2')::NUMERIC, '%', 'final',
        COALESCE(v_rec.visit_date::TIMESTAMPTZ, now())
      ) ON CONFLICT DO NOTHING;
      v_inserted := v_inserted + 1;
    END IF;

  END LOOP;

  RAISE NOTICE 'Back-filled % observation rows from vitals_json.', v_inserted;
END
$$;

-- ══════════════════════════════════════════════
-- 3. Deprecation comments on legacy vital columns
-- ══════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='visits' AND column_name='temperature') THEN
    COMMENT ON COLUMN public.visits.temperature IS
      'DEPRECATED: Store vitals in observations table (LOINC 8310-5). '
      'Kept for backward compatibility only.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='visits' AND column_name='weight') THEN
    COMMENT ON COLUMN public.visits.weight IS
      'DEPRECATED: Store vitals in observations table (LOINC 29463-7). '
      'Kept for backward compatibility only.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='visits' AND column_name='blood_pressure') THEN
    COMMENT ON COLUMN public.visits.blood_pressure IS
      'DEPRECATED: Store vitals in observations (LOINC 8480-6/8462-4). '
      'Kept for backward compatibility only.';
  END IF;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
DO $$
DECLARE
  v_total_obs        BIGINT;
  v_visits_with_obs  BIGINT;
  v_visits_with_json BIGINT := 0;
BEGIN
  SELECT COUNT(*)             INTO v_total_obs       FROM public.observations;
  SELECT COUNT(DISTINCT visit_id) INTO v_visits_with_obs FROM public.observations;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='visits'
               AND column_name='vitals_json') THEN
    EXECUTE 'SELECT COUNT(*) FROM public.visits
             WHERE vitals_json IS NOT NULL AND vitals_json <> ''{}''::jsonb'
    INTO v_visits_with_json;
  END IF;

  RAISE NOTICE 'FIX_13 verification: total_observations=%, visits_with_observations=%, visits_with_vitals_json=%',
    v_total_obs, v_visits_with_obs, v_visits_with_json;
END
$$;
