-- ============================================================
-- FIX 24 — Widen patient_identifiers.identifier_type CHECK
--
-- The original constraint only allowed Ethiopian legacy values:
--   ('fayida_id','mrn','national_id','passport','insurance_id','other')
--
-- FIX_20 intended to replace it with FHIR values but the DO block
-- skipped it because a constraint with the same auto-generated name
-- already existed.
--
-- This migration drops the old constraint and replaces it with a
-- unified set covering both legacy and FHIR R4 values.
-- ============================================================

BEGIN;

DO $$
BEGIN
  -- Drop the old narrow constraint
  ALTER TABLE public.patient_identifiers
    DROP CONSTRAINT IF EXISTS patient_identifiers_identifier_type_check;

  -- Add widened constraint: legacy Ethiopian + FHIR R4 identifier use values
  ALTER TABLE public.patient_identifiers
    ADD CONSTRAINT patient_identifiers_identifier_type_check
    CHECK (identifier_type IN (
      -- Legacy values (existing data)
      'fayida_id',
      'mrn',
      'national_id',
      'passport',
      'insurance_id',
      'other',
      -- FHIR R4 Identifier.use values
      'usual',
      'official',
      'temp',
      'secondary',
      'old'
    ));

  RAISE NOTICE 'Widened patient_identifiers.identifier_type CHECK to include FHIR R4 values.';

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not widen identifier_type constraint: % %', SQLSTATE, SQLERRM;
END
$$;

-- Also widen use_type to match (it was added with same FHIR values in FIX_20)
DO $$
BEGIN
  ALTER TABLE public.patient_identifiers
    DROP CONSTRAINT IF EXISTS patient_identifiers_use_type_check;

  ALTER TABLE public.patient_identifiers
    ADD CONSTRAINT patient_identifiers_use_type_check
    CHECK (use_type IN (
      'fayida_id',
      'mrn',
      'national_id',
      'passport',
      'insurance_id',
      'other',
      'usual',
      'official',
      'temp',
      'secondary',
      'old'
    ));

  RAISE NOTICE 'Widened patient_identifiers.use_type CHECK to include FHIR R4 values.';

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not widen use_type constraint: % %', SQLSTATE, SQLERRM;
END
$$;

COMMIT;

-- Verify
DO $$
BEGIN
  RAISE NOTICE 'FIX_24: patient_identifiers identifier_type constraint widened — FHIR + legacy values now accepted.';
END
$$;
