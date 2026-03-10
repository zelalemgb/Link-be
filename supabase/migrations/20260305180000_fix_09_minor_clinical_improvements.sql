-- ============================================================
-- FIX 09 — MINOR: Clinical Data Quality Improvements
-- ============================================================
-- Covers:
--   a) Lab result units + numeric value column
--   b) Visit status transition audit table
--   c) Structured clinical observations table (FHIR Observation)
--   d) Visit clinical notes with full-text search
--   e) Medication dispense history
--   f) Normalised referrals table
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════
-- a) Lab result units + numeric value
-- ══════════════════════════════════════════════
-- Problem: lab_orders.result stores everything as TEXT, making
-- numeric comparisons (e.g. Hb < 7.0) impossible without casting.

ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS result_value_numeric NUMERIC,
  ADD COLUMN IF NOT EXISTS result_unit           TEXT,
  ADD COLUMN IF NOT EXISTS reference_range_low   NUMERIC,
  ADD COLUMN IF NOT EXISTS reference_range_high  NUMERIC,
  ADD COLUMN IF NOT EXISTS reference_range_text  TEXT,
  ADD COLUMN IF NOT EXISTS abnormal_flag         TEXT
    CHECK (abnormal_flag IN ('normal', 'low', 'high', 'critical_low', 'critical_high', 'abnormal', NULL));

-- Index: find abnormal results fast (guard facility_id — column may not exist)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lab_orders' AND column_name = 'facility_id'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_lab_orders_abnormal') THEN
      EXECUTE 'CREATE INDEX idx_lab_orders_abnormal
        ON public.lab_orders(facility_id, abnormal_flag, status)
        WHERE abnormal_flag IN (''critical_low'', ''critical_high'', ''abnormal'')';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_lab_orders_abnormal') THEN
      EXECUTE 'CREATE INDEX idx_lab_orders_abnormal
        ON public.lab_orders(abnormal_flag, status)
        WHERE abnormal_flag IN (''critical_low'', ''critical_high'', ''abnormal'')';
    END IF;
  END IF;
END
$$;

COMMENT ON COLUMN public.lab_orders.result_value_numeric IS
  'Machine-readable numeric result. Parse from result TEXT on entry; '
  'used for trend charts and abnormal flagging.';

COMMENT ON COLUMN public.lab_orders.result_unit IS
  'Unit of measurement (e.g. g/dL, mmol/L, ×10³/μL). '
  'Should follow UCUM standard where possible.';

-- ══════════════════════════════════════════════
-- b) Visit status transition audit
-- ══════════════════════════════════════════════
-- Problem: visits.status changes are not audited — no way to
-- reconstruct the patient journey timeline or measure stage durations.

CREATE TABLE IF NOT EXISTS public.visit_status_transitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants(id),
  facility_id   UUID NOT NULL REFERENCES public.facilities(id),
  visit_id      UUID NOT NULL REFERENCES public.visits(id) ON DELETE RESTRICT,
  patient_id    UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  from_status   TEXT,    -- NULL for initial status set
  to_status     TEXT NOT NULL,
  transition_reason TEXT,
  transitioned_by   UUID REFERENCES public.users(id),
  transitioned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Duration in previous status (seconds)
  duration_seconds INTEGER,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vst_visit
  ON public.visit_status_transitions(visit_id, transitioned_at DESC);

CREATE INDEX IF NOT EXISTS idx_vst_facility_date
  ON public.visit_status_transitions(facility_id, transitioned_at DESC);

ALTER TABLE public.visit_status_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view status transitions"
  ON public.visit_status_transitions FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "System can insert status transitions"
  ON public.visit_status_transitions FOR INSERT
  WITH CHECK (facility_id = public.get_user_facility_id());

-- Trigger: auto-insert a transition row whenever visits.status changes
CREATE OR REPLACE FUNCTION public.log_visit_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_changed_at TIMESTAMPTZ;
  v_duration        INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- Calculate duration in previous status
    v_prev_changed_at := COALESCE(OLD.status_updated_at, OLD.created_at);
    v_duration := EXTRACT(EPOCH FROM (now() - v_prev_changed_at))::INTEGER;

    INSERT INTO public.visit_status_transitions (
      tenant_id, facility_id, visit_id, patient_id,
      from_status, to_status,
      transitioned_by, transitioned_at, duration_seconds
    ) VALUES (
      NEW.tenant_id,
      NEW.facility_id,
      NEW.id,
      NEW.patient_id,
      OLD.status,
      NEW.status,
      (SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1),
      now(),
      v_duration
    );
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_log_visit_status_transition'
      AND tgrelid = 'public.visits'::regclass
  ) THEN
    CREATE TRIGGER trg_log_visit_status_transition
      AFTER UPDATE ON public.visits
      FOR EACH ROW
      EXECUTE FUNCTION public.log_visit_status_transition();
  END IF;
END
$$;

-- ══════════════════════════════════════════════
-- c) Structured clinical observations (FHIR Observation)
-- ══════════════════════════════════════════════
-- Problem: vital signs are scattered as loose columns on visits
-- (temperature, weight, blood_pressure) with no LOINC codes,
-- no time-series support, and no observer tracking.

CREATE TABLE IF NOT EXISTS public.observations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES public.tenants(id),
  facility_id     UUID NOT NULL REFERENCES public.facilities(id),
  visit_id        UUID NOT NULL REFERENCES public.visits(id) ON DELETE RESTRICT,
  patient_id      UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  -- LOINC code (preferred)
  loinc_code      TEXT,      -- e.g. '8310-5' (body temperature)
  display_name    TEXT NOT NULL, -- e.g. 'Body Temperature'

  -- Value (one of: numeric, text, boolean, coded)
  value_numeric   NUMERIC,
  value_text      TEXT,
  value_boolean   BOOLEAN,
  value_coded     TEXT,       -- SNOMED/custom coded value

  unit            TEXT,       -- UCUM unit (e.g. 'Cel', 'kg', 'mm[Hg]')

  -- Reference range
  ref_range_low   NUMERIC,
  ref_range_high  NUMERIC,
  abnormal_flag   TEXT
    CHECK (abnormal_flag IN ('normal', 'low', 'high', 'critical_low', 'critical_high', NULL)),

  -- Timing
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  observed_by     UUID REFERENCES public.users(id),

  -- Status (FHIR Observation.status)
  status          TEXT NOT NULL DEFAULT 'final'
    CHECK (status IN ('registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled')),

  -- Provenance
  method          TEXT,       -- e.g. 'axillary', 'oral', 'rectal' for temperature
  device          TEXT,       -- device model if relevant

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_obs_visit
  ON public.observations(visit_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_obs_patient_loinc
  ON public.observations(patient_id, loinc_code, observed_at DESC)
  WHERE loinc_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_obs_abnormal
  ON public.observations(facility_id, abnormal_flag, observed_at DESC)
  WHERE abnormal_flag IN ('critical_low', 'critical_high');

CREATE TRIGGER update_observations_updated_at
  BEFORE UPDATE ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view observations"
  ON public.observations FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "Clinical staff can create observations"
  ON public.observations FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_clinical_staff()
  );

-- ══════════════════════════════════════════════
-- d) Visit clinical notes with full-text search
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.visit_clinical_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES public.tenants(id),
  facility_id   UUID NOT NULL REFERENCES public.facilities(id),
  visit_id      UUID NOT NULL REFERENCES public.visits(id) ON DELETE RESTRICT,
  patient_id    UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  note_type     TEXT NOT NULL DEFAULT 'progress'
    CHECK (note_type IN (
      'history',        -- history of presenting illness
      'examination',    -- physical examination findings
      'assessment',     -- clinical assessment / impression
      'plan',           -- management plan
      'progress',       -- progress note
      'discharge',      -- discharge summary
      'referral',       -- referral letter
      'procedure',      -- procedure note
      'consent'         -- consent documentation
    )),

  note_text     TEXT NOT NULL,
  note_fts      TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', note_text)
  ) STORED,

  is_confidential BOOLEAN NOT NULL DEFAULT FALSE,
  is_signed       BOOLEAN NOT NULL DEFAULT FALSE,
  signed_at       TIMESTAMPTZ,
  signed_by       UUID REFERENCES public.users(id),

  authored_by   UUID NOT NULL REFERENCES public.users(id),
  authored_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_vcn_fts
  ON public.visit_clinical_notes USING GIN(note_fts);

CREATE INDEX IF NOT EXISTS idx_vcn_visit
  ON public.visit_clinical_notes(visit_id, note_type)
  WHERE deleted_at IS NULL;

CREATE TRIGGER update_visit_clinical_notes_updated_at
  BEFORE UPDATE ON public.visit_clinical_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.visit_clinical_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinical staff can view notes"
  ON public.visit_clinical_notes FOR SELECT
  USING (
    facility_id = public.get_user_facility_id()
    AND deleted_at IS NULL
    AND (
      NOT is_confidential
      OR public.is_clinical_staff()
    )
  );

CREATE POLICY "Clinical staff can create notes"
  ON public.visit_clinical_notes FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_clinical_staff()
  );

-- ══════════════════════════════════════════════
-- e) Medication dispense history
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.medication_dispense (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES public.tenants(id),
  facility_id         UUID NOT NULL REFERENCES public.facilities(id),
  medication_order_id UUID NOT NULL REFERENCES public.medication_orders(id) ON DELETE RESTRICT,
  visit_id            UUID NOT NULL REFERENCES public.visits(id) ON DELETE RESTRICT,
  patient_id          UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  -- What was dispensed
  medication_name     TEXT NOT NULL,
  quantity_dispensed  NUMERIC NOT NULL CHECK (quantity_dispensed > 0),
  unit                TEXT,                    -- 'tablet', 'ml', 'vial', etc.
  batch_number        TEXT,
  expiry_date         DATE,

  -- Dispensing event
  dispensed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispensed_by        UUID NOT NULL REFERENCES public.users(id),

  -- Patient counselling
  counselling_given   BOOLEAN DEFAULT FALSE,
  patient_acknowledged BOOLEAN DEFAULT FALSE,

  -- Status
  status              TEXT NOT NULL DEFAULT 'dispensed'
    CHECK (status IN ('dispensed', 'returned', 'wasted', 'not_dispensed')),

  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_md_order
  ON public.medication_dispense(medication_order_id);

CREATE INDEX IF NOT EXISTS idx_md_patient_date
  ON public.medication_dispense(patient_id, dispensed_at DESC);

CREATE INDEX IF NOT EXISTS idx_md_facility_date
  ON public.medication_dispense(facility_id, dispensed_at DESC);

CREATE TRIGGER update_medication_dispense_updated_at
  BEFORE UPDATE ON public.medication_dispense
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.medication_dispense ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Pharmacy staff can view dispense records"
  ON public.medication_dispense FOR SELECT
  USING (facility_id = public.get_user_facility_id());

CREATE POLICY "Pharmacy staff can create dispense records"
  ON public.medication_dispense FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_pharmacy_staff()
  );

-- ══════════════════════════════════════════════
-- f) Normalised referrals table
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.referrals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES public.tenants(id),
  facility_id           UUID NOT NULL REFERENCES public.facilities(id),
  visit_id              UUID NOT NULL REFERENCES public.visits(id) ON DELETE RESTRICT,
  patient_id            UUID NOT NULL REFERENCES public.patients(id) ON DELETE RESTRICT,

  -- Direction
  referral_direction    TEXT NOT NULL DEFAULT 'outgoing'
    CHECK (referral_direction IN ('outgoing', 'incoming')),

  -- Destination / Source
  referred_to_facility  TEXT,          -- facility name (external)
  referred_to_dept      TEXT,          -- department / specialty
  referred_from_facility TEXT,         -- for incoming referrals
  reason_for_referral   TEXT NOT NULL,

  -- Clinical context
  urgency               TEXT NOT NULL DEFAULT 'routine'
    CHECK (urgency IN ('routine', 'urgent', 'emergency')),

  diagnosis_at_referral TEXT,          -- working diagnosis when referred
  clinical_summary      TEXT,          -- brief clinical notes

  -- Status lifecycle
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'accepted',
      'rejected',
      'completed',
      'cancelled'
    )),

  -- Tracking
  referred_by           UUID NOT NULL REFERENCES public.users(id),
  referred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at           TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  feedback_received_at  TIMESTAMPTZ,
  feedback_notes        TEXT,          -- feedback from receiving facility

  -- Transport
  transport_arranged    BOOLEAN DEFAULT FALSE,
  transport_notes       TEXT,

  -- Document
  referral_letter_url   TEXT,          -- stored in Supabase Storage

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_visit
  ON public.referrals(visit_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_referrals_patient
  ON public.referrals(patient_id, referred_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_referrals_facility_status
  ON public.referrals(facility_id, status, referred_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER update_referrals_updated_at
  BEFORE UPDATE ON public.referrals
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facility staff can view referrals"
  ON public.referrals FOR SELECT
  USING (
    facility_id = public.get_user_facility_id()
    AND deleted_at IS NULL
  );

CREATE POLICY "Clinical staff can create referrals"
  ON public.referrals FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_clinical_staff()
  );

CREATE POLICY "Clinical staff can update referrals"
  ON public.referrals FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND public.is_clinical_staff()
  );

COMMIT;

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT table_name, count(*) AS columns
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'observations',
    'visit_clinical_notes',
    'visit_status_transitions',
    'medication_dispense',
    'referrals'
  )
GROUP BY table_name
ORDER BY table_name;
