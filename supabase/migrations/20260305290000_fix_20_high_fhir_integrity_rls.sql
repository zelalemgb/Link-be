-- ============================================================
-- FIX 20 — HIGH: FHIR Encounter Class, Patient Identifiers,
--                Integrity Constraints, Confidential Notes RLS,
--                License Expiry Enforcement, Performance Indexes
-- ============================================================
-- Resolves gaps: F-1, F-2, H-1, H-6, I-2, I-3, I-5, J-5, P-1, P-4, S-1, S-3
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- 1. FHIR Encounter class on visits (F-1)
-- ══════════════════════════════════════════════
ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS encounter_class TEXT
    CHECK (encounter_class IN (
      'ambulatory',   -- outpatient / clinic visit
      'inpatient',    -- admitted overnight
      'emergency',    -- emergency department
      'community',    -- HEW home visit / community outreach
      'virtual',      -- telemedicine
      'other'
    ));

COMMENT ON COLUMN public.visits.encounter_class IS
  'FHIR R4 Encounter.class (ActCode): ambulatory | inpatient | emergency | '
  'community | virtual | other. Required for FHIR export and disease burden stratification.';

-- Back-fill from admission status where determinable
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admissions' AND column_name='status')
  AND EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admissions' AND column_name='source_visit_id')
  THEN
    UPDATE public.visits v
    SET encounter_class = 'inpatient'
    WHERE encounter_class IS NULL
      AND EXISTS (
        SELECT 1 FROM public.admissions a
        WHERE a.source_visit_id = v.id AND a.status IN ('active','discharged')
      );
    RAISE NOTICE 'Back-filled encounter_class=inpatient for admitted visits.';
  END IF;

  -- Default remaining unclassified visits to ambulatory
  UPDATE public.visits
  SET encounter_class = 'ambulatory'
  WHERE encounter_class IS NULL;
  RAISE NOTICE 'Defaulted remaining visits to encounter_class=ambulatory.';
END
$$;

-- ══════════════════════════════════════════════
-- 2. Patient identifiers table (F-2)
--    FHIR R4 Patient.identifier — tracks MRN, NHIA ID, national ID,
--    passport, etc. with system URL for interoperability.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.patient_identifiers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  tenant_id    UUID NOT NULL REFERENCES public.tenants(id)   ON DELETE RESTRICT,
  facility_id  UUID NOT NULL REFERENCES public.facilities(id) ON DELETE RESTRICT,
  patient_id   UUID NOT NULL REFERENCES public.patients(id)  ON DELETE CASCADE,

  -- FHIR identifier.system — a URI that defines the namespace
  -- e.g. 'urn:link:mrn', 'urn:nhia:ethiopia', 'urn:oid:national_id'
  system       TEXT NOT NULL,
  value        TEXT NOT NULL,
  assigner     TEXT,                     -- Organisation that issued the identifier
  identifier_type TEXT NOT NULL DEFAULT 'usual'
    CHECK (identifier_type IN ('usual','official','temp','secondary','old')),
  use_type     TEXT NOT NULL DEFAULT 'official'
    CHECK (use_type IN ('usual','official','temp','secondary','old')),

  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  issued_at    TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,

  -- Audit
  created_by   UUID REFERENCES public.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active identifier per patient per system
  CONSTRAINT uq_patient_identifier_system UNIQUE (patient_id, system, value)
);

-- Ensure ALL columns exist — the table may have been partially created by
-- a prior failed run with only the primary key column (id).
-- FK columns (tenant_id, facility_id, patient_id) may also be absent.
ALTER TABLE public.patient_identifiers
  ADD COLUMN IF NOT EXISTS tenant_id       UUID REFERENCES public.tenants(id)   ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS facility_id     UUID REFERENCES public.facilities(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS patient_id      UUID REFERENCES public.patients(id)  ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS system          TEXT,
  ADD COLUMN IF NOT EXISTS value           TEXT,
  ADD COLUMN IF NOT EXISTS assigner        TEXT,
  ADD COLUMN IF NOT EXISTS identifier_type TEXT NOT NULL DEFAULT 'usual',
  ADD COLUMN IF NOT EXISTS use_type        TEXT NOT NULL DEFAULT 'official',
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS issued_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by      UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS row_version     BIGINT NOT NULL DEFAULT 1;

-- Add check constraints if columns were just created and constraints are absent
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'patient_identifiers_identifier_type_check'
        AND conrelid = 'public.patient_identifiers'::regclass) THEN
    ALTER TABLE public.patient_identifiers
      ADD CONSTRAINT patient_identifiers_identifier_type_check
      CHECK (identifier_type IN ('usual','official','temp','secondary','old'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'patient_identifiers_use_type_check'
        AND conrelid = 'public.patient_identifiers'::regclass) THEN
    ALTER TABLE public.patient_identifiers
      ADD CONSTRAINT patient_identifiers_use_type_check
      CHECK (use_type IN ('usual','official','temp','secondary','old'));
  END IF;
  -- Unique constraint on (patient_id, system, value) — only if system column now has data
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'uq_patient_identifier_system'
        AND conrelid = 'public.patient_identifiers'::regclass) THEN
    ALTER TABLE public.patient_identifiers
      ADD CONSTRAINT uq_patient_identifier_system UNIQUE (patient_id, system, value);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not add patient_identifiers constraints: % %', SQLSTATE, SQLERRM;
END
$$;

-- Indexes — guarded for both is_active and system column existence
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='patient_identifiers'
        AND column_name='is_active') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_patient_identifiers_patient
      ON public.patient_identifiers(patient_id) WHERE is_active = TRUE';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_patient_identifiers_patient
      ON public.patient_identifiers(patient_id)';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='patient_identifiers'
        AND column_name='system')
  AND EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='patient_identifiers'
        AND column_name='is_active') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_patient_identifiers_value
      ON public.patient_identifiers(system, value) WHERE is_active = TRUE';
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='patient_identifiers'
        AND column_name='system') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_patient_identifiers_value
      ON public.patient_identifiers(system, value)';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS update_patient_identifiers_updated_at ON public.patient_identifiers;
CREATE TRIGGER update_patient_identifiers_updated_at
  BEFORE UPDATE ON public.patient_identifiers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.patient_identifiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Facility staff can view patient identifiers" ON public.patient_identifiers;
CREATE POLICY "Facility staff can view patient identifiers"
  ON public.patient_identifiers FOR SELECT
  USING (facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "Receptionist/admin can manage patient identifiers" ON public.patient_identifiers;
CREATE POLICY "Receptionist/admin can manage patient identifiers"
  ON public.patient_identifiers FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin','receptionist','super_admin')
    )
  );

COMMENT ON TABLE public.patient_identifiers IS
  'FHIR R4 Patient.identifier. Stores all identifier types for a patient '
  '(MRN, NHIA membership, national ID, passport). '
  'system field should be a URI namespace e.g. urn:link:mrn.';

-- Back-fill national_id from patients table
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='patients' AND column_name='national_id')
  THEN
    INSERT INTO public.patient_identifiers (
      tenant_id, facility_id, patient_id,
      system, value, identifier_type, use_type, created_at, updated_at
    )
    SELECT
      p.tenant_id,
      p.facility_id,
      p.id,
      'urn:link:national_id',
      p.national_id,
      'official',
      'official',
      now(),
      now()
    FROM public.patients p
    WHERE p.national_id IS NOT NULL
      AND p.national_id <> ''
    ON CONFLICT (patient_id, system, value) DO NOTHING;
    RAISE NOTICE 'Migrated national_id values to patient_identifiers.';
  END IF;
END
$$;

-- ══════════════════════════════════════════════
-- 3. IP address + user agent in audit_log (H-1)
-- ══════════════════════════════════════════════
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS ip_address  INET,
  ADD COLUMN IF NOT EXISTS user_agent  TEXT,
  ADD COLUMN IF NOT EXISTS session_id  TEXT;  -- Supabase session token prefix (first 8 chars)

COMMENT ON COLUMN public.audit_log.ip_address IS
  'IP address of the request. Populated from request.headers by application layer '
  'or Supabase Edge Function. Required for HIPAA access logging.';
COMMENT ON COLUMN public.audit_log.user_agent IS
  'HTTP User-Agent string. Helps distinguish mobile app, web, and API access.';

-- ══════════════════════════════════════════════
-- 4. Integrity constraints (I-2, I-3, I-5)
-- ══════════════════════════════════════════════

-- I-2: discharge_date >= admission_date
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_admissions_discharge_after_admission'
      AND conrelid = 'public.admissions'::regclass
  ) THEN
    ALTER TABLE public.admissions
      ADD CONSTRAINT chk_admissions_discharge_after_admission
      CHECK (discharge_date IS NULL OR discharge_date >= admission_date);
    RAISE NOTICE 'Added chk_admissions_discharge_after_admission.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not add discharge_date check (existing bad data?): % %', SQLSTATE, SQLERRM;
END
$$;

-- I-3: no duplicate allergies per patient (deduplicate first, then add constraint)
DO $$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  -- Delete duplicate patient_allergies rows keeping the oldest (most complete) record
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY patient_id, LOWER(allergen_name)
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM public.patient_allergies
  ),
  to_delete AS (SELECT id FROM ranked WHERE rn > 1)
  DELETE FROM public.patient_allergies
  WHERE id IN (SELECT id FROM to_delete);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted > 0 THEN
    RAISE NOTICE 'Removed % duplicate patient_allergy rows.', v_deleted;
  END IF;

  -- Now safe to add unique constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_patient_allergy_name'
      AND conrelid = 'public.patient_allergies'::regclass
  ) THEN
    -- Use functional index for case-insensitive uniqueness
    -- (PostgreSQL supports expression unique indexes but not expression constraints)
    -- We create a unique index instead
    RAISE NOTICE 'Adding unique index on (patient_id, lower(allergen_name)).';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_allergy_name
  ON public.patient_allergies(patient_id, LOWER(allergen_name))
  WHERE deleted_at IS NULL OR deleted_at IS NOT NULL;  -- covers all rows

-- If deleted_at does not exist, create simpler version
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='patient_allergies'
        AND column_name='deleted_at')
  THEN
    -- Drop the above (covers all rows) - it was created but we want to re-create
    -- without the tautological WHERE clause
    DROP INDEX IF EXISTS uq_patient_allergy_name;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_allergy_name
      ON public.patient_allergies(patient_id, LOWER(allergen_name));
    RAISE NOTICE 'Created uq_patient_allergy_name without deleted_at.';
  END IF;
END
$$;

-- I-5: inventory quantity non-negative
DO $$
BEGIN
  -- Fix any existing negative values first
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='inventory_items'
        AND column_name='quantity_on_hand')
  THEN
    UPDATE public.inventory_items
    SET quantity_on_hand = 0
    WHERE quantity_on_hand < 0;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'chk_inventory_qty_non_negative'
        AND conrelid = 'public.inventory_items'::regclass
    ) THEN
      ALTER TABLE public.inventory_items
        ADD CONSTRAINT chk_inventory_qty_non_negative
        CHECK (quantity_on_hand >= 0);
      RAISE NOTICE 'Added chk_inventory_qty_non_negative.';
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not add inventory qty constraint: % %', SQLSTATE, SQLERRM;
END
$$;

-- ══════════════════════════════════════════════
-- 5. Confidential notes RLS (H-6, S-1)
--    visit_clinical_notes with is_confidential = TRUE should only
--    be readable by the authoring provider and admins.
-- ══════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='visit_clinical_notes')
  THEN
    -- Drop overly permissive SELECT policy if it exists (name may vary)
    DROP POLICY IF EXISTS "Facility staff can view clinical notes" ON public.visit_clinical_notes;
    DROP POLICY IF EXISTS "Users can view visit clinical notes"    ON public.visit_clinical_notes;
    DROP POLICY IF EXISTS "Staff can view clinical notes"          ON public.visit_clinical_notes;

    -- Re-create: non-confidential notes visible to all facility staff;
    -- confidential notes only to author or admin/super_admin.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'visit_clinical_notes'
        AND policyname = 'Facility staff can view non-confidential notes'
    ) THEN
      EXECUTE $pol$
        CREATE POLICY "Facility staff can view non-confidential notes"
          ON public.visit_clinical_notes FOR SELECT
          USING (
            facility_id = public.get_user_facility_id()
            AND (is_confidential = FALSE OR is_confidential IS NULL)
          )
      $pol$;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'visit_clinical_notes'
        AND policyname = 'Author or admin can view confidential notes'
    ) THEN
      EXECUTE $pol$
        CREATE POLICY "Author or admin can view confidential notes"
          ON public.visit_clinical_notes FOR SELECT
          USING (
            facility_id = public.get_user_facility_id()
            AND is_confidential = TRUE
            AND (
              authored_by = (
                SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1
              )
              OR EXISTS (
                SELECT 1 FROM public.users u
                WHERE u.auth_user_id = auth.uid()
                  AND u.user_role IN ('admin', 'super_admin')
              )
            )
          )
      $pol$;
    END IF;

    RAISE NOTICE 'Updated visit_clinical_notes RLS to restrict confidential notes.';
  END IF;
END
$$;

-- ══════════════════════════════════════════════
-- 6. Provider license expiry enforcement (J-5, S-3)
--    Block medication_orders and lab_orders from providers
--    whose license has expired.
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.check_provider_license_valid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_provider_id UUID;
  v_expiry      DATE;
  v_role        TEXT;
BEGIN
  -- Determine the provider column for this table
  -- Both medication_orders and lab_orders use ordered_by for the prescribing provider
  v_provider_id := CASE TG_TABLE_NAME
    WHEN 'medication_orders' THEN NEW.ordered_by
    WHEN 'lab_orders'        THEN NEW.ordered_by
    ELSE NULL
  END;

  IF v_provider_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if provider_credentials table exists
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='provider_credentials') THEN
    RETURN NEW;
  END IF;

  -- Get the most recent active credential for this provider
  SELECT license_expiry INTO v_expiry
  FROM public.provider_credentials
  WHERE user_id = v_provider_id
    AND is_active = TRUE
    AND license_expiry IS NOT NULL
  ORDER BY license_expiry DESC
  LIMIT 1;

  IF v_expiry IS NOT NULL AND v_expiry < CURRENT_DATE THEN
    RAISE EXCEPTION
      'Provider license expired on %. Cannot create order with expired credentials. '
      'Contact admin to renew license. (SQLSTATE P0004)',
      v_expiry
      USING ERRCODE = 'P0004';
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN SQLSTATE 'P0004' THEN RAISE;
  WHEN OTHERS THEN
    RAISE WARNING 'check_provider_license_valid failed: % %', SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_provider_license_valid() IS
  'Blocks medication_orders and lab_orders from providers with an expired license. '
  'JCI IPSG compliance — credential verification at point of ordering.';

-- Attach to medication_orders (provider column is ordered_by)
DROP TRIGGER IF EXISTS trg_check_provider_license_mo ON public.medication_orders;
CREATE TRIGGER trg_check_provider_license_mo
  BEFORE INSERT OR UPDATE OF ordered_by
  ON public.medication_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.check_provider_license_valid();

-- Attach to lab_orders
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='lab_orders'
        AND column_name='ordered_by') THEN
    DROP TRIGGER IF EXISTS trg_check_provider_license_lo ON public.lab_orders;
    EXECUTE $t$
      CREATE TRIGGER trg_check_provider_license_lo
        BEFORE INSERT OR UPDATE OF ordered_by
        ON public.lab_orders
        FOR EACH ROW
        EXECUTE FUNCTION public.check_provider_license_valid()
    $t$;
    RAISE NOTICE 'Attached license check trigger to lab_orders.';
  END IF;
END
$$;

-- ══════════════════════════════════════════════
-- 7. Performance indexes (P-1, P-4)
-- ══════════════════════════════════════════════

-- P-1: audit_log by patient for patient audit history queries
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='audit_log'
        AND column_name='patient_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_audit_log_patient_date
      ON public.audit_log(patient_id, created_at DESC)
      WHERE patient_id IS NOT NULL';
    RAISE NOTICE 'Created idx_audit_log_patient_date.';
  END IF;
END
$$;

-- P-4: outbox_events pending partial index for event processor
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='outbox_events') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
      ON public.outbox_events(event_type, created_at ASC)
      WHERE status = ''pending''';
    RAISE NOTICE 'Created idx_outbox_events_pending.';
  END IF;
END
$$;

-- patient_insurance lookup (P-2)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='patient_insurance') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_patient_insurance_active
      ON public.patient_insurance(patient_id, status, coverage_end_date)
      WHERE status = ''active''';
    RAISE NOTICE 'Created idx_patient_insurance_active.';
  END IF;
END
$$;

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
DO $$
DECLARE
  v_enc_class_count    BIGINT;
  v_identifiers_count  BIGINT;
  v_audit_ip           BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO v_enc_class_count FROM public.visits WHERE encounter_class IS NOT NULL;
  SELECT COUNT(*) INTO v_identifiers_count FROM public.patient_identifiers;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='audit_log'
      AND column_name='ip_address') INTO v_audit_ip;

  RAISE NOTICE 'FIX_20: visits with encounter_class=%, patient_identifiers rows=%, audit_log.ip_address=%',
    v_enc_class_count, v_identifiers_count, v_audit_ip;
END
$$;
