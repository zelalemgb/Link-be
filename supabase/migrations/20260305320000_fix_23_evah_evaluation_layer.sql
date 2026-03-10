-- ============================================================
-- FIX 23 — EVAH EVALUATION LAYER
--    Four tables required for the Evidence on AI for Health
--    (EVAH) initiative's rigorous independent evaluation:
--
--    1. ai_interaction_logs      — AI suggestion vs. provider decision
--    2. referrals                — Outgoing/incoming referral lifecycle
--    3. clinical_alerts          — Red-flag alert generation & disposition
--    4. guideline_adherence_events — Protocol adherence per visit
--
-- NOTE: Every CREATE TABLE IF NOT EXISTS is followed immediately by
-- a comprehensive ALTER TABLE ... ADD COLUMN IF NOT EXISTS block.
-- This handles partial-run artifacts where the table exists with
-- only its primary key column.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════════════════════
-- 1. AI INTERACTION LOGS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.ai_interaction_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

ALTER TABLE public.ai_interaction_logs
  ADD COLUMN IF NOT EXISTS tenant_id             UUID REFERENCES public.tenants(id)    ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS facility_id           UUID REFERENCES public.facilities(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS visit_id              UUID REFERENCES public.visits(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS patient_id            UUID REFERENCES public.patients(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_id           UUID REFERENCES public.users(id)      ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS interaction_type      TEXT NOT NULL DEFAULT 'diagnosis_suggestion',
  ADD COLUMN IF NOT EXISTS ai_model              TEXT,
  ADD COLUMN IF NOT EXISTS ai_version            TEXT,
  ADD COLUMN IF NOT EXISTS session_id            TEXT,
  ADD COLUMN IF NOT EXISTS suggestion_data       JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS confidence_score      NUMERIC,
  ADD COLUMN IF NOT EXISTS provider_action       TEXT NOT NULL DEFAULT 'no_response',
  ADD COLUMN IF NOT EXISTS provider_response_data JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS response_time_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS clinical_justification TEXT,
  ADD COLUMN IF NOT EXISTS suggested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS responded_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_version           BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ NOT NULL DEFAULT now();

-- Constraints (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'ai_interaction_logs_interaction_type_check'
        AND conrelid = 'public.ai_interaction_logs'::regclass) THEN
    ALTER TABLE public.ai_interaction_logs
      ADD CONSTRAINT ai_interaction_logs_interaction_type_check
      CHECK (interaction_type IN (
        'triage_suggestion','symptom_flag','diagnosis_suggestion',
        'lab_suggestion','medication_suggestion','referral_suggestion',
        'guideline_alert','red_flag_alert','followup_suggestion'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'ai_interaction_logs_provider_action_check'
        AND conrelid = 'public.ai_interaction_logs'::regclass) THEN
    ALTER TABLE public.ai_interaction_logs
      ADD CONSTRAINT ai_interaction_logs_provider_action_check
      CHECK (provider_action IN ('accepted','modified','rejected','ignored','deferred','no_response'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'ai_interaction_logs_confidence_check'
        AND conrelid = 'public.ai_interaction_logs'::regclass) THEN
    ALTER TABLE public.ai_interaction_logs
      ADD CONSTRAINT ai_interaction_logs_confidence_check
      CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ai_interaction_logs constraints: % %', SQLSTATE, SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS idx_ai_logs_visit
  ON public.ai_interaction_logs(visit_id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_provider_date
  ON public.ai_interaction_logs(provider_id, suggested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_type_action
  ON public.ai_interaction_logs(interaction_type, provider_action);
CREATE INDEX IF NOT EXISTS idx_ai_logs_facility_date
  ON public.ai_interaction_logs(facility_id, suggested_at DESC);

DROP TRIGGER IF EXISTS update_ai_interaction_logs_updated_at ON public.ai_interaction_logs;
CREATE TRIGGER update_ai_interaction_logs_updated_at
  BEFORE UPDATE ON public.ai_interaction_logs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS bump_ai_interaction_logs_row_version ON public.ai_interaction_logs;
CREATE TRIGGER bump_ai_interaction_logs_row_version
  BEFORE UPDATE ON public.ai_interaction_logs
  FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

ALTER TABLE public.ai_interaction_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Facility staff can view AI logs" ON public.ai_interaction_logs;
CREATE POLICY "Facility staff can view AI logs"
  ON public.ai_interaction_logs FOR SELECT
  USING (facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "System can insert AI logs" ON public.ai_interaction_logs;
CREATE POLICY "System can insert AI logs"
  ON public.ai_interaction_logs FOR INSERT
  WITH CHECK (facility_id = public.get_user_facility_id());

COMMENT ON TABLE public.ai_interaction_logs IS
  'EVAH primary evaluation table. Records every AI suggestion presented '
  'to a provider, the provider''s response, and response latency. '
  'Enables computation of AI acceptance rate, modification rate, '
  'and correlation of AI-guided decisions with patient outcomes.';

-- ══════════════════════════════════════════════════════════════
-- 2. REFERRALS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS tenant_id              UUID REFERENCES public.tenants(id)            ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS visit_id               UUID REFERENCES public.visits(id)             ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS patient_id             UUID REFERENCES public.patients(id)           ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS referral_direction     TEXT NOT NULL DEFAULT 'outgoing',
  ADD COLUMN IF NOT EXISTS referring_facility_id  UUID REFERENCES public.facilities(id)         ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS receiving_facility_name TEXT,
  ADD COLUMN IF NOT EXISTS receiving_facility_id  UUID REFERENCES public.facilities(id)         ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referred_by            UUID REFERENCES public.users(id)              ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_by            UUID REFERENCES public.users(id)              ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS urgency                TEXT NOT NULL DEFAULT 'routine',
  ADD COLUMN IF NOT EXISTS referral_reason        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS clinical_summary       TEXT,
  ADD COLUMN IF NOT EXISTS icd_code               TEXT,
  ADD COLUMN IF NOT EXISTS referred_service       TEXT,
  ADD COLUMN IF NOT EXISTS ai_suggested           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_log_id              UUID REFERENCES public.ai_interaction_logs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status                 TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS referred_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS accepted_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attended_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason       TEXT,
  ADD COLUMN IF NOT EXISTS dna_reason             TEXT,
  ADD COLUMN IF NOT EXISTS outcome_summary        TEXT,
  ADD COLUMN IF NOT EXISTS feedback_from_receiver TEXT,
  ADD COLUMN IF NOT EXISTS feedback_received_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_version            BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT now();

-- Constraints (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'referrals_direction_check'
        AND conrelid = 'public.referrals'::regclass) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_direction_check
      CHECK (referral_direction IN ('outgoing','incoming'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'referrals_urgency_check'
        AND conrelid = 'public.referrals'::regclass) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_urgency_check
      CHECK (urgency IN ('routine','urgent','emergency'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'referrals_status_check'
        AND conrelid = 'public.referrals'::regclass) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_status_check
      CHECK (status IN ('pending','accepted','rejected','attended','did_not_attend','completed','cancelled'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'referrals constraints: % %', SQLSTATE, SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS idx_referrals_patient
  ON public.referrals(patient_id, referred_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='referrals'
        AND column_name='referring_facility_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_referrals_facility_status
      ON public.referrals(referring_facility_id, status)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='referrals'
        AND column_name='status')
  AND EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='referrals'
        AND column_name='referred_at') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_referrals_pending
      ON public.referrals(status, referred_at ASC)
      WHERE status = ''pending''';
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_referrals_updated_at ON public.referrals;
CREATE TRIGGER update_referrals_updated_at
  BEFORE UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS bump_referrals_row_version ON public.referrals;
CREATE TRIGGER bump_referrals_row_version
  BEFORE UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Facility staff can view referrals" ON public.referrals;
CREATE POLICY "Facility staff can view referrals"
  ON public.referrals FOR SELECT
  USING (referring_facility_id = public.get_user_facility_id()
      OR receiving_facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "Clinicians can create referrals" ON public.referrals;
CREATE POLICY "Clinicians can create referrals"
  ON public.referrals FOR INSERT
  WITH CHECK (
    referring_facility_id = public.get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('doctor','clinical_officer','nurse','admin','super_admin')
    )
  );

COMMENT ON TABLE public.referrals IS
  'Full lifecycle of patient referrals (outgoing and incoming). '
  'Enables EVAH evaluation of care continuity, referral acceptance rates, '
  'DNA rates, and outcomes at receiving facilities. '
  'ai_suggested flag links to ai_interaction_logs for impact measurement.';

-- ══════════════════════════════════════════════════════════════
-- 3. CLINICAL ALERTS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.clinical_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

ALTER TABLE public.clinical_alerts
  ADD COLUMN IF NOT EXISTS tenant_id           UUID REFERENCES public.tenants(id)    ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS facility_id         UUID REFERENCES public.facilities(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS visit_id            UUID REFERENCES public.visits(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS patient_id          UUID REFERENCES public.patients(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_provider_id  UUID REFERENCES public.users(id)      ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS alert_type          TEXT NOT NULL DEFAULT 'red_flag',
  ADD COLUMN IF NOT EXISTS severity            TEXT NOT NULL DEFAULT 'high',
  ADD COLUMN IF NOT EXISTS triggered_by        TEXT NOT NULL DEFAULT 'rule_engine',
  ADD COLUMN IF NOT EXISTS trigger_data        JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS alert_message       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS alert_code          TEXT,
  ADD COLUMN IF NOT EXISTS acknowledged_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by     UUID REFERENCES public.users(id)      ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS action_taken        TEXT,
  ADD COLUMN IF NOT EXISTS dismissed_reason    TEXT,
  ADD COLUMN IF NOT EXISTS alert_status        TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS resolved_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_outcome     TEXT,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_recorded_by UUID REFERENCES public.users(id)      ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS row_version         BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT now();

-- Constraints (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'clinical_alerts_type_check'
        AND conrelid = 'public.clinical_alerts'::regclass) THEN
    ALTER TABLE public.clinical_alerts
      ADD CONSTRAINT clinical_alerts_type_check
      CHECK (alert_type IN ('red_flag','drug_interaction','contraindication',
        'allergy_alert','critical_lab_value','protocol_deviation',
        'license_expiry','duplicate_order','missed_screening','followup_overdue'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'clinical_alerts_severity_check'
        AND conrelid = 'public.clinical_alerts'::regclass) THEN
    ALTER TABLE public.clinical_alerts
      ADD CONSTRAINT clinical_alerts_severity_check
      CHECK (severity IN ('critical','high','medium','low'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'clinical_alerts_triggered_by_check'
        AND conrelid = 'public.clinical_alerts'::regclass) THEN
    ALTER TABLE public.clinical_alerts
      ADD CONSTRAINT clinical_alerts_triggered_by_check
      CHECK (triggered_by IN ('ai','rule_engine','manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'clinical_alerts_status_check'
        AND conrelid = 'public.clinical_alerts'::regclass) THEN
    ALTER TABLE public.clinical_alerts
      ADD CONSTRAINT clinical_alerts_status_check
      CHECK (alert_status IN ('active','acknowledged','dismissed','auto_resolved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'clinical_alerts_outcome_check'
        AND conrelid = 'public.clinical_alerts'::regclass) THEN
    ALTER TABLE public.clinical_alerts
      ADD CONSTRAINT clinical_alerts_outcome_check
      CHECK (patient_outcome IS NULL OR patient_outcome IN
        ('improved','unchanged','deteriorated','transferred','died','unknown'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'clinical_alerts constraints: % %', SQLSTATE, SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS idx_clinical_alerts_visit
  ON public.clinical_alerts(visit_id);
CREATE INDEX IF NOT EXISTS idx_clinical_alerts_patient
  ON public.clinical_alerts(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clinical_alerts_type
  ON public.clinical_alerts(alert_type, triggered_by);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='clinical_alerts'
        AND column_name='facility_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='clinical_alerts'
        AND column_name='alert_status') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_clinical_alerts_active
      ON public.clinical_alerts(facility_id, severity, created_at DESC)
      WHERE alert_status = ''active''';
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_clinical_alerts_updated_at ON public.clinical_alerts;
CREATE TRIGGER update_clinical_alerts_updated_at
  BEFORE UPDATE ON public.clinical_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS bump_clinical_alerts_row_version ON public.clinical_alerts;
CREATE TRIGGER bump_clinical_alerts_row_version
  BEFORE UPDATE ON public.clinical_alerts
  FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

ALTER TABLE public.clinical_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Facility staff can view clinical alerts" ON public.clinical_alerts;
CREATE POLICY "Facility staff can view clinical alerts"
  ON public.clinical_alerts FOR SELECT
  USING (facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "System and clinicians can insert alerts" ON public.clinical_alerts;
CREATE POLICY "System and clinicians can insert alerts"
  ON public.clinical_alerts FOR INSERT
  WITH CHECK (facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "Provider can acknowledge their alerts" ON public.clinical_alerts;
CREATE POLICY "Provider can acknowledge their alerts"
  ON public.clinical_alerts FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND (
      target_provider_id = (
        SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1
      )
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.auth_user_id = auth.uid()
          AND u.user_role IN ('admin','super_admin')
      )
    )
  );

COMMENT ON TABLE public.clinical_alerts IS
  'Every clinical alert raised by AI, rule engine, or manually. '
  'Tracks provider acknowledgement, action taken, and patient outcome. '
  'EVAH: measures alert acknowledgement rate, time-to-acknowledge, '
  'and whether acted-on alerts lead to better outcomes than dismissed ones.';

-- ══════════════════════════════════════════════════════════════
-- 4. GUIDELINE ADHERENCE EVENTS
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.guideline_adherence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

ALTER TABLE public.guideline_adherence_events
  ADD COLUMN IF NOT EXISTS tenant_id              UUID REFERENCES public.tenants(id)    ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS facility_id            UUID REFERENCES public.facilities(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS visit_id               UUID REFERENCES public.visits(id)     ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS patient_id             UUID REFERENCES public.patients(id)   ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_id            UUID REFERENCES public.users(id)      ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS guideline_code         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS guideline_name         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS guideline_version      TEXT,
  ADD COLUMN IF NOT EXISTS condition_icd          TEXT,
  ADD COLUMN IF NOT EXISTS condition_name         TEXT,
  ADD COLUMN IF NOT EXISTS required_action        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS action_type            TEXT NOT NULL DEFAULT 'documentation',
  ADD COLUMN IF NOT EXISTS was_performed          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS performed_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS performed_entity_type  TEXT,
  ADD COLUMN IF NOT EXISTS performed_entity_id    UUID,
  ADD COLUMN IF NOT EXISTS deviation_reason       TEXT,
  ADD COLUMN IF NOT EXISTS deviation_category     TEXT,
  ADD COLUMN IF NOT EXISTS evaluator              TEXT NOT NULL DEFAULT 'rule_engine',
  ADD COLUMN IF NOT EXISTS evaluation_confidence  NUMERIC,
  ADD COLUMN IF NOT EXISTS row_version            BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT now();

-- Constraints (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'guideline_adherence_action_type_check'
        AND conrelid = 'public.guideline_adherence_events'::regclass) THEN
    ALTER TABLE public.guideline_adherence_events
      ADD CONSTRAINT guideline_adherence_action_type_check
      CHECK (action_type IN ('lab_order','imaging_order','medication','referral',
        'counseling','followup_scheduled','vital_sign_check',
        'screening','vaccination','documentation'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'guideline_adherence_deviation_cat_check'
        AND conrelid = 'public.guideline_adherence_events'::regclass) THEN
    ALTER TABLE public.guideline_adherence_events
      ADD CONSTRAINT guideline_adherence_deviation_cat_check
      CHECK (deviation_category IS NULL OR deviation_category IN (
        'stock_out','patient_refused','clinical_judgement',
        'equipment_unavailable','not_applicable','documented_elsewhere','unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'guideline_adherence_evaluator_check'
        AND conrelid = 'public.guideline_adherence_events'::regclass) THEN
    ALTER TABLE public.guideline_adherence_events
      ADD CONSTRAINT guideline_adherence_evaluator_check
      CHECK (evaluator IN ('ai','rule_engine','manual_audit'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'guideline_adherence_events constraints: % %', SQLSTATE, SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS idx_guideline_adherence_visit
  ON public.guideline_adherence_events(visit_id);
CREATE INDEX IF NOT EXISTS idx_guideline_adherence_facility_date
  ON public.guideline_adherence_events(facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guideline_adherence_code
  ON public.guideline_adherence_events(guideline_code, was_performed);
CREATE INDEX IF NOT EXISTS idx_guideline_adherence_provider
  ON public.guideline_adherence_events(provider_id, guideline_code);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='guideline_adherence_events'
        AND column_name='was_performed') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_guideline_adherence_deviations
      ON public.guideline_adherence_events(facility_id, guideline_code, created_at DESC)
      WHERE was_performed = FALSE';
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_guideline_adherence_updated_at ON public.guideline_adherence_events;
CREATE TRIGGER update_guideline_adherence_updated_at
  BEFORE UPDATE ON public.guideline_adherence_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS bump_guideline_adherence_row_version ON public.guideline_adherence_events;
CREATE TRIGGER bump_guideline_adherence_row_version
  BEFORE UPDATE ON public.guideline_adherence_events
  FOR EACH ROW EXECUTE FUNCTION public.bump_row_version();

ALTER TABLE public.guideline_adherence_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Facility staff can view guideline adherence" ON public.guideline_adherence_events;
CREATE POLICY "Facility staff can view guideline adherence"
  ON public.guideline_adherence_events FOR SELECT
  USING (facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "System can insert guideline adherence events" ON public.guideline_adherence_events;
CREATE POLICY "System can insert guideline adherence events"
  ON public.guideline_adherence_events FOR INSERT
  WITH CHECK (facility_id = public.get_user_facility_id());

COMMENT ON TABLE public.guideline_adherence_events IS
  'One row per protocol action expected per visit. '
  'Enables EVAH computation of guideline adherence rate per provider, '
  'facility, guideline, and time period. Deviation reasons support '
  'root-cause analysis for quality improvement and policy feedback.';

COMMIT;

-- ──────────────────────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_ai_logs   BOOLEAN; v_referrals BOOLEAN;
  v_alerts    BOOLEAN; v_adherence BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ai_interaction_logs'
      AND column_name='facility_id') INTO v_ai_logs;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='referrals'
      AND column_name='referring_facility_id') INTO v_referrals;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='clinical_alerts'
      AND column_name='facility_id') INTO v_alerts;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='guideline_adherence_events'
      AND column_name='guideline_code') INTO v_adherence;
  RAISE NOTICE 'FIX_23 EVAH: ai_interaction_logs=%, referrals=%, clinical_alerts=%, guideline_adherence_events=%',
    v_ai_logs, v_referrals, v_alerts, v_adherence;
END $$;
