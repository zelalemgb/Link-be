-- ============================================================
-- FIX 10 — CRITICAL: user_role ENUM completeness + Age computation
-- ============================================================
-- Problems:
--   1. user_role ENUM is missing values that are actively used in RLS
--      policies and application code: 'accountant', 'lab_scientist',
--      'pharmacy_technician'. Because these values are absent from the
--      enum, every comparison against them required a ::TEXT cast, which
--      bypasses type safety entirely.
--
--   2. patients.age INTEGER stores a static value that becomes stale the
--      day after the patient's birthday.  date_of_birth is the
--      authoritative source; age must be computed, not stored.
--
-- Fix:
--   Part A — Add all missing roles to the enum (idempotent IF NOT EXISTS).
--             Clean up ::TEXT casts in payment_journal policies by
--             recreating them without the cast.
--   Part B — Trigger to auto-compute age from date_of_birth on every
--             INSERT/UPDATE of patients.
--             View v_patients that always exposes a current age.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- PART A: user_role ENUM — add missing values
-- ══════════════════════════════════════════════

-- Values used in code but not in enum
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'accountant';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'lab_scientist';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'pharmacy_technician';

-- Also add hew (Health Extension Worker) used in hew_role migration
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'hew';

-- Commit the enum changes — PostgreSQL requires enum additions
-- to be committed before they can be used in the same transaction.
COMMIT;
BEGIN;

-- ══════════════════════════════════════════════
-- PART A (continued): Refresh payment_journal policies now that
-- 'accountant' is a proper enum value — remove the ::TEXT workaround.
-- ══════════════════════════════════════════════

DO $$
BEGIN
  -- Only rewrite if payment_journals table exists (it was created in FIX 07)
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payment_journals'
  ) THEN
    DROP POLICY IF EXISTS "Finance staff can insert payment journals"
      ON public.payment_journals;

    EXECUTE $pol$
      CREATE POLICY "Finance staff can insert payment journals"
        ON public.payment_journals FOR INSERT
        WITH CHECK (
          facility_id = public.get_user_facility_id()
          AND EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.auth_user_id = auth.uid()
              AND u.user_role IN ('admin', 'receptionist', 'accountant', 'super_admin')
          )
        )
    $pol$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payment_reconciliations'
  ) THEN
    DROP POLICY IF EXISTS "Receptionist/admin can create reconciliations"
      ON public.payment_reconciliations;
    DROP POLICY IF EXISTS "Admin can approve reconciliations"
      ON public.payment_reconciliations;

    EXECUTE $pol$
      CREATE POLICY "Receptionist/admin can create reconciliations"
        ON public.payment_reconciliations FOR INSERT
        WITH CHECK (
          facility_id = public.get_user_facility_id()
          AND EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.auth_user_id = auth.uid()
              AND u.user_role IN ('admin', 'receptionist', 'accountant', 'super_admin')
          )
        )
    $pol$;

    EXECUTE $pol$
      CREATE POLICY "Admin can approve reconciliations"
        ON public.payment_reconciliations FOR UPDATE
        USING (
          facility_id = public.get_user_facility_id()
          AND EXISTS (
            SELECT 1 FROM public.users u
            WHERE u.auth_user_id = auth.uid()
              AND u.user_role IN ('admin', 'super_admin')
          )
        )
    $pol$;
  END IF;
END
$$;

-- ══════════════════════════════════════════════
-- PART B: Age computation
-- ══════════════════════════════════════════════

-- Step 1: Add a trigger that keeps patients.age in sync with date_of_birth.
--         This covers both direct INSERTs and any UPDATE of date_of_birth.
CREATE OR REPLACE FUNCTION public.sync_patient_age()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only compute if date_of_birth is set; otherwise leave age as-is
  IF NEW.date_of_birth IS NOT NULL THEN
    NEW.age := DATE_PART('year', AGE(CURRENT_DATE, NEW.date_of_birth))::INTEGER;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_patient_age() IS
  'Keeps patients.age in sync with date_of_birth. '
  'The age column is deprecated as authoritative source; '
  'always use v_patients.current_age for display.';

-- Remove old trigger if it exists, then create fresh
DROP TRIGGER IF EXISTS trg_sync_patient_age ON public.patients;

CREATE TRIGGER trg_sync_patient_age
  BEFORE INSERT OR UPDATE OF date_of_birth ON public.patients
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_patient_age();

-- Step 2: Relax the age check constraint to allow 0 (newborns / infants < 1 yr).
--         The original constraint likely had age > 0 or age >= 1 which rejects
--         any patient whose date_of_birth is within the last 12 months.
DO $$
DECLARE
  v_con RECORD;
BEGIN
  -- Find and drop any existing age check constraint on patients
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.patients'::regclass
      AND contype = 'c'
      AND conname ILIKE '%age%'
  LOOP
    EXECUTE format('ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS %I', v_con.conname);
    RAISE NOTICE 'Dropped constraint %', v_con.conname;
  END LOOP;
END
$$;

-- Re-add with correct range: 0 (newborn) to 150 years
ALTER TABLE public.patients
  ADD CONSTRAINT patients_age_check
  CHECK (age IS NULL OR (age >= 0 AND age <= 150));

-- Step 3: Back-fill age for existing rows where date_of_birth is a valid past date.
--         Skip rows where date_of_birth is in the future (bad test data) or NULL.
UPDATE public.patients
SET age = DATE_PART('year', AGE(CURRENT_DATE, date_of_birth))::INTEGER
WHERE date_of_birth IS NOT NULL
  AND date_of_birth <= CURRENT_DATE          -- exclude future dates (data errors)
  AND (age IS NULL OR age <> DATE_PART('year', AGE(CURRENT_DATE, date_of_birth))::INTEGER);

-- Step 4: View that always returns a fresh computed current_age alongside
--         all patient columns. Application code should use this view for
--         any age-sensitive display or query.
CREATE OR REPLACE VIEW public.v_patients AS
SELECT
  p.*,
  CASE
    WHEN p.date_of_birth IS NOT NULL
    THEN DATE_PART('year', AGE(CURRENT_DATE, p.date_of_birth))::INTEGER
    ELSE p.age
  END AS current_age,
  CASE
    WHEN p.date_of_birth IS NOT NULL THEN
      CASE
        WHEN DATE_PART('year', AGE(CURRENT_DATE, p.date_of_birth)) < 1
          THEN FLOOR(DATE_PART('month', AGE(CURRENT_DATE, p.date_of_birth)))::TEXT || ' months'
        ELSE DATE_PART('year', AGE(CURRENT_DATE, p.date_of_birth))::TEXT || ' years'
      END
    ELSE NULL
  END AS age_display
FROM public.patients p;

COMMENT ON VIEW public.v_patients IS
  'Patients with computed current_age and age_display. '
  'Always prefer current_age over the stored age column for display. '
  'The stored age column is maintained by trigger for backward compatibility.';

-- Add deprecation comment to the column itself
COMMENT ON COLUMN public.patients.age IS
  'DEPRECATED: Use v_patients.current_age instead. '
  'Maintained by trigger sync_patient_age for backward compatibility. '
  'Will be removed in a future migration.';

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT 'user_role enum values' AS check_name,
       string_agg(enumlabel, ', ' ORDER BY enumsortorder) AS values
FROM pg_enum
JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
WHERE pg_type.typname = 'user_role';

SELECT 'patients age sync check' AS check_name,
       COUNT(*) FILTER (WHERE date_of_birth IS NOT NULL AND age IS NULL)      AS missing_age,
       COUNT(*) FILTER (WHERE date_of_birth IS NOT NULL
         AND age <> DATE_PART('year', AGE(CURRENT_DATE, date_of_birth))::INTEGER) AS stale_age,
       COUNT(*)                                                                AS total_patients
FROM public.patients;
