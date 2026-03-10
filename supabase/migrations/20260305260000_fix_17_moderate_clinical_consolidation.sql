-- ============================================================
-- FIX 17 — MODERATE: Clinical Consolidation
-- ============================================================
-- Covers:
--   a) Migrate visit_narratives → visit_clinical_notes (unify note tables)
--   b) diagnoses_json sync trigger (JSONB → normalised diagnoses rows)
--   c) Critical lab result → outbox_events notification wiring
--   d) appointment_slots scheduling table
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- a) Migrate visit_narratives → visit_clinical_notes
-- ══════════════════════════════════════════════
-- Map visit_narratives.narrative_type → visit_clinical_notes.note_type
DO $$
DECLARE
  v_inserted INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'visit_narratives'
  ) THEN
    RAISE NOTICE 'visit_narratives does not exist — skipping migration.';
    RETURN;
  END IF;

  INSERT INTO public.visit_clinical_notes (
    tenant_id, facility_id, visit_id, patient_id,
    note_type, note_text,
    is_confidential, is_signed, signed_at, signed_by,
    authored_by, authored_at,
    created_at, updated_at
  )
  SELECT
    vn.tenant_id,
    v.facility_id,
    vn.visit_id,
    vn.patient_id,
    -- Map narrative_type to note_type (closest equivalent)
    CASE vn.narrative_type
      WHEN 'chief_complaint'    THEN 'history'
      WHEN 'hpi'                THEN 'history'
      WHEN 'ros'                THEN 'history'
      WHEN 'physical_exam'      THEN 'examination'
      WHEN 'assessment'         THEN 'assessment'
      WHEN 'plan'               THEN 'plan'
      WHEN 'progress_note'      THEN 'progress'
      WHEN 'discharge_summary'  THEN 'discharge'
      ELSE 'progress'
    END AS note_type,
    vn.narrative_text                     AS note_text,
    FALSE                                 AS is_confidential,
    COALESCE(vn.is_signed, FALSE)         AS is_signed,
    vn.signed_at,
    vn.signed_by,
    vn.authored_by,
    vn.authored_at,
    vn.created_at,
    vn.updated_at
  FROM public.visit_narratives vn
  JOIN public.visits v ON v.id = vn.visit_id
  WHERE NOT EXISTS (
    -- Idempotent: skip rows already migrated
    SELECT 1 FROM public.visit_clinical_notes vcn
    WHERE vcn.visit_id  = vn.visit_id
      AND vcn.authored_by = vn.authored_by
      AND vcn.authored_at = vn.authored_at
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'Migrated % visit_narratives rows to visit_clinical_notes.', v_inserted;
END
$$;

-- Add deprecation comment to visit_narratives
COMMENT ON TABLE public.visit_narratives IS
  'DEPRECATED: All new clinical notes should be written to visit_clinical_notes. '
  'Historical rows have been migrated. This table will be dropped in a future migration.';

-- ══════════════════════════════════════════════
-- b) diagnoses_json sync trigger
--    When a visit is updated with a diagnoses_json JSONB array,
--    normalise the array into the diagnoses table.
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.sync_diagnoses_from_json()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_diag     JSONB;
  v_user_id  UUID;
BEGIN
  -- Only run when diagnoses_json actually changed
  IF OLD.diagnoses_json IS NOT DISTINCT FROM NEW.diagnoses_json THEN
    RETURN NEW;
  END IF;

  IF NEW.diagnoses_json IS NULL OR jsonb_array_length(NEW.diagnoses_json) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_user_id FROM public.users
  WHERE auth_user_id = auth.uid() LIMIT 1;

  FOR v_diag IN SELECT * FROM jsonb_array_elements(NEW.diagnoses_json)
  LOOP
    INSERT INTO public.diagnoses (
      tenant_id, facility_id, visit_id, patient_id,
      icd10_code, display_name,
      diagnosis_type, certainty, clinical_status,
      source_table, source_field,
      created_by, created_at, updated_at
    )
    VALUES (
      NEW.tenant_id,
      NEW.facility_id,
      NEW.id,
      NEW.patient_id,
      v_diag->>'icd_code',
      COALESCE(v_diag->>'display_name', v_diag->>'name', 'Unknown'),
      COALESCE(v_diag->>'diagnosis_type', 'provisional'),
      COALESCE(v_diag->>'certainty', 'unconfirmed'),
      'active',
      'visits',
      'diagnoses_json',
      COALESCE(v_user_id, NEW.created_by),
      now(),
      now()
    )
    ON CONFLICT DO NOTHING;  -- Avoid duplicating if trigger fires multiple times
  END LOOP;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_diagnoses_from_json failed: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

-- Only attach if diagnoses_json column exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'visits'
      AND column_name = 'diagnoses_json'
  ) THEN
    DROP TRIGGER IF EXISTS trg_sync_diagnoses_json ON public.visits;
    CREATE TRIGGER trg_sync_diagnoses_json
      AFTER INSERT OR UPDATE OF diagnoses_json ON public.visits
      FOR EACH ROW
      EXECUTE FUNCTION public.sync_diagnoses_from_json();
    RAISE NOTICE 'Attached sync_diagnoses_from_json trigger to visits.';
  ELSE
    RAISE NOTICE 'visits.diagnoses_json column not found — trigger not attached.';
  END IF;
END
$$;

-- ══════════════════════════════════════════════
-- c) Critical lab result → outbox_events
-- ══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.notify_critical_lab_result()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only fire when abnormal_flag transitions TO a critical value
  IF NEW.abnormal_flag IN ('critical_low', 'critical_high')
    AND (OLD.abnormal_flag IS DISTINCT FROM NEW.abnormal_flag)
  THEN
    INSERT INTO public.outbox_events (
      tenant_id,
      event_type,
      event_version,
      aggregate_type,
      aggregate_id,
      payload,
      metadata,
      created_by,
      created_at,
      created_date
    )
    SELECT
      NEW.tenant_id,
      'lab_result.critical',
      'v1',
      'lab_order',
      NEW.id,
      jsonb_build_object(
        'lab_order_id',   NEW.id,
        'patient_id',     NEW.patient_id,
        'visit_id',       NEW.visit_id,
        'facility_id',    NEW.facility_id,
        'test_name',      NEW.test_name,
        'abnormal_flag',  NEW.abnormal_flag,
        'result',         NEW.result,
        'result_numeric', NEW.result_value_numeric,
        'result_unit',    NEW.result_unit,
        'ordered_by',     NEW.ordered_by,
        'completed_at',   NEW.completed_at
      ),
      jsonb_build_object(
        'priority', 'critical',
        'notification_type', 'critical_lab_alert'
      ),
      NEW.ordered_by,
      now(),
      CURRENT_DATE;
  END IF;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_critical_lab_result failed: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_critical_lab_alert ON public.lab_orders;

CREATE TRIGGER trg_critical_lab_alert
  AFTER UPDATE OF abnormal_flag ON public.lab_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_critical_lab_result();

-- ══════════════════════════════════════════════
-- d) Appointment slots scheduling table
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.appointment_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  tenant_id     UUID NOT NULL REFERENCES public.tenants(id),
  facility_id   UUID NOT NULL REFERENCES public.facilities(id),
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,

  -- Provider & resource
  provider_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  -- Time
  start_time    TIMESTAMPTZ NOT NULL,
  end_time      TIMESTAMPTZ NOT NULL,
  duration_mins SMALLINT NOT NULL GENERATED ALWAYS AS (
    CAST(EXTRACT(EPOCH FROM (end_time - start_time)) / 60.0 AS SMALLINT)
  ) STORED,

  -- Slot type
  slot_type TEXT NOT NULL DEFAULT 'consultation'
    CHECK (slot_type IN (
      'consultation', 'follow_up', 'procedure', 'anc', 'immunization',
      'lab_collection', 'imaging', 'vaccination', 'other'
    )),

  -- Availability
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_blocked   BOOLEAN NOT NULL DEFAULT FALSE,
  block_reason TEXT,

  -- Booking
  appointment_request_id UUID REFERENCES public.patient_appointment_requests(id) ON DELETE SET NULL,
  patient_id             UUID REFERENCES public.patients(id) ON DELETE SET NULL,
  visit_id               UUID REFERENCES public.visits(id) ON DELETE SET NULL,

  -- Status
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN (
      'open',       -- available for booking
      'booked',     -- patient assigned
      'completed',  -- visit happened
      'no_show',    -- patient did not attend
      'cancelled',
      'blocked'     -- unavailable (staff leave, etc.)
    )),

  notes TEXT,

  -- Audit
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_slot_end_after_start CHECK (end_time > start_time),
  CONSTRAINT chk_slot_booked_has_patient
    CHECK (status != 'booked' OR patient_id IS NOT NULL)
);

-- Prevent double-booking: one patient per slot, one slot per provider per time window
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_slots_provider_time
  ON public.appointment_slots(provider_user_id, start_time)
  WHERE provider_user_id IS NOT NULL AND status NOT IN ('cancelled', 'blocked');

CREATE INDEX IF NOT EXISTS idx_appt_slots_facility_date
  ON public.appointment_slots(facility_id, start_time, status);

CREATE INDEX IF NOT EXISTS idx_appt_slots_patient
  ON public.appointment_slots(patient_id)
  WHERE patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appt_slots_available
  ON public.appointment_slots(facility_id, department_id, slot_type, start_time)
  WHERE is_available = TRUE AND is_blocked = FALSE AND status = 'open';

CREATE TRIGGER update_appointment_slots_updated_at
  BEFORE UPDATE ON public.appointment_slots
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.appointment_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view appointment slots"
  ON public.appointment_slots FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "Admin or receptionist can manage appointment slots"
  ON public.appointment_slots FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin', 'receptionist', 'nurse', 'super_admin', 'doctor', 'clinical_officer')
    )
  );

CREATE POLICY "Admin or receptionist can update appointment slots"
  ON public.appointment_slots FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('admin', 'receptionist', 'nurse', 'super_admin', 'doctor', 'clinical_officer')
    )
  );

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  'visit_clinical_notes' AS table_name, COUNT(*) AS rows
FROM public.visit_clinical_notes
UNION ALL
SELECT 'appointment_slots', COUNT(*) FROM public.appointment_slots
UNION ALL
SELECT 'outbox_events pending critical labs', COUNT(*)
  FROM public.outbox_events
  WHERE event_type = 'lab_result.critical' AND status = 'pending';
