-- ============================================================
-- FIX 05 — MAJOR: Missing Compound Indexes for Clinical Workflows
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────
-- visits: queue by facility + date (primary dashboard query)
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_visits_facility_date
  ON public.visits(facility_id, visit_date DESC)
  WHERE deleted_at IS NULL;

-- visits: multi-tenant dashboard
CREATE INDEX IF NOT EXISTS idx_visits_tenant_facility_date
  ON public.visits(tenant_id, facility_id, visit_date DESC)
  WHERE deleted_at IS NULL;

-- visits: status-based queue filtering
CREATE INDEX IF NOT EXISTS idx_visits_facility_status
  ON public.visits(facility_id, status)
  WHERE deleted_at IS NULL;

-- ──────────────────────────────────────────────
-- lab_orders: safe columns (visit_id + patient_id always exist)
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lab_orders_visit_status
  ON public.lab_orders(visit_id, status);

CREATE INDEX IF NOT EXISTS idx_lab_orders_patient_id_status
  ON public.lab_orders(patient_id, status);

-- lab_orders: test_code (only if column exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lab_orders' AND column_name = 'test_code'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS idx_lab_orders_patient_test_status
        ON public.lab_orders(patient_id, test_code, status)
    $idx$;
    RAISE NOTICE 'Created idx_lab_orders_patient_test_status';
  ELSE
    RAISE NOTICE 'lab_orders.test_code not found — skipping';
  END IF;
END $$;

-- lab_orders: facility_id (only if column exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lab_orders' AND column_name = 'facility_id'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS idx_lab_orders_facility_status_created
        ON public.lab_orders(facility_id, status, created_at DESC)
        WHERE status NOT IN ('completed', 'cancelled')
    $idx$;
    RAISE NOTICE 'Created idx_lab_orders_facility_status_created';
  ELSE
    RAISE NOTICE 'lab_orders.facility_id not found — skipping facility index';
  END IF;
END $$;

-- ──────────────────────────────────────────────
-- medication_orders: safe columns
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_medication_orders_visit_status
  ON public.medication_orders(visit_id, status);

CREATE INDEX IF NOT EXISTS idx_medication_orders_patient_status
  ON public.medication_orders(patient_id, status);

-- medication_orders: medication_name (only if column exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medication_orders' AND column_name = 'medication_name'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS idx_medication_orders_patient_name_status
        ON public.medication_orders(patient_id, medication_name, status)
    $idx$;
    RAISE NOTICE 'Created idx_medication_orders_patient_name_status';
  ELSE
    RAISE NOTICE 'medication_orders.medication_name not found — skipping';
  END IF;
END $$;

-- ──────────────────────────────────────────────
-- imaging_orders: safe columns
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_imaging_orders_visit_status
  ON public.imaging_orders(visit_id, status);

-- ──────────────────────────────────────────────
-- patients: DOB search within facility
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'date_of_birth'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS idx_patients_facility_dob
        ON public.patients(facility_id, date_of_birth)
        WHERE deleted_at IS NULL
    $idx$;
    RAISE NOTICE 'Created idx_patients_facility_dob';
  ELSE
    RAISE NOTICE 'patients.date_of_birth not found — skipping DOB index';
  END IF;
END $$;

-- patients: phone lookup
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'phone'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS idx_patients_facility_phone
        ON public.patients(facility_id, phone)
        WHERE phone IS NOT NULL AND deleted_at IS NULL
    $idx$;
    RAISE NOTICE 'Created idx_patients_facility_phone';
  END IF;
END $$;

-- ──────────────────────────────────────────────
-- anc_assessments
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_anc_facility_gestational
  ON public.anc_assessments(facility_id, gestational_age_weeks);

CREATE INDEX IF NOT EXISTS idx_anc_facility_edd
  ON public.anc_assessments(facility_id, expected_delivery_date)
  WHERE expected_delivery_date IS NOT NULL;

-- ──────────────────────────────────────────────
-- delivery_records
-- ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_delivery_facility_datetime
  ON public.delivery_records(facility_id, delivery_datetime DESC);

-- ──────────────────────────────────────────────
-- billing_items (if table exists)
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'billing_items'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS idx_billing_items_visit_service
        ON public.billing_items(visit_id, service_id)
    $idx$;
    RAISE NOTICE 'Created idx_billing_items_visit_service';
  END IF;
END $$;

-- ──────────────────────────────────────────────
-- diagnoses table (created by FIX_02)
-- ──────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'diagnoses'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS idx_diagnoses_patient_type
        ON public.diagnoses(patient_id, diagnosis_type, clinical_status)
        WHERE deleted_at IS NULL
    $idx$;
    RAISE NOTICE 'Created idx_diagnoses_patient_type';
  END IF;
END $$;

COMMIT;

-- Verification
SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'idx_%'
  AND tablename IN (
    'visits', 'lab_orders', 'medication_orders', 'imaging_orders',
    'patients', 'anc_assessments', 'delivery_records', 'billing_items', 'diagnoses'
  )
ORDER BY tablename, indexname;
