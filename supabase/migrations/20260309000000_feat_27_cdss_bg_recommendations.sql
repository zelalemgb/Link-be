-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: feat_27_cdss_bg_recommendations
-- Creates the cdss_recommendations table for logging background CDSS advisor
-- suggestions and tracking whether doctors accepted or ignored each one.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Create the cdss_recommendations table ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cdss_recommendations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id            UUID        NOT NULL REFERENCES public.visits(id)      ON DELETE CASCADE,
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id)     ON DELETE CASCADE,
  facility_id         UUID        NOT NULL REFERENCES public.facilities(id)  ON DELETE CASCADE,

  -- Recommendation metadata
  recommendation_type TEXT        NOT NULL
    CHECK (recommendation_type IN ('diagnosis', 'treatment', 'alert', 'referral')),
  recommendation_text TEXT        NOT NULL,
  source              TEXT,                       -- Guideline name / AI model identifier

  -- Clinical context captured at the moment the recommendation fired
  context_snapshot    JSONB,                      -- {complaint, vitals, diagnosis, labOrders, …}

  -- Doctor's response
  doctor_response     TEXT        NOT NULL DEFAULT 'pending'
    CHECK (doctor_response IN ('accepted', 'ignored', 'pending')),
  responded_at        TIMESTAMPTZ,                -- NULL until doctor acts

  -- Optimistic-locking / audit
  row_version         INTEGER     NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. Indexes for common query patterns ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cdss_rec_visit_id
  ON public.cdss_recommendations (visit_id);

CREATE INDEX IF NOT EXISTS idx_cdss_rec_tenant_facility
  ON public.cdss_recommendations (tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_cdss_rec_created_at
  ON public.cdss_recommendations (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cdss_rec_type
  ON public.cdss_recommendations (recommendation_type);

CREATE INDEX IF NOT EXISTS idx_cdss_rec_response
  ON public.cdss_recommendations (doctor_response)
  WHERE doctor_response = 'pending';

-- ── 3. Row-version bump trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bump_cdss_rec_row_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_at  := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cdss_rec_rv ON public.cdss_recommendations;
CREATE TRIGGER trg_cdss_rec_rv
  BEFORE UPDATE ON public.cdss_recommendations
  FOR EACH ROW EXECUTE FUNCTION public.bump_cdss_rec_row_version();

-- ── 4. Row-Level Security ────────────────────────────────────────────────────
ALTER TABLE public.cdss_recommendations ENABLE ROW LEVEL SECURITY;

-- Doctors and nurses in the same tenant+facility can view recommendations
CREATE POLICY "cdss_rec_select" ON public.cdss_recommendations
  FOR SELECT
  USING (public.row_matches_user_scope(tenant_id, facility_id));

-- Only authenticated users in the same tenant+facility can insert
CREATE POLICY "cdss_rec_insert" ON public.cdss_recommendations
  FOR INSERT
  WITH CHECK (public.row_matches_user_scope(tenant_id, facility_id));

-- Only authenticated users in the same tenant+facility can update (respond)
CREATE POLICY "cdss_rec_update" ON public.cdss_recommendations
  FOR UPDATE
  USING (public.row_matches_user_scope(tenant_id, facility_id));

-- ── 5. Comment the table ────────────────────────────────────────────────────
COMMENT ON TABLE public.cdss_recommendations IS
  'Background CDSS advisor log — every diagnosis/treatment recommendation shown '
  'to a doctor is recorded here along with the clinical context and the doctor''s '
  'response (accepted | ignored | pending).';

COMMENT ON COLUMN public.cdss_recommendations.context_snapshot IS
  'JSON snapshot of clinical context at recommendation time: '
  '{complaint, vitals, diagnosis, labOrders, imagingOrders, …}';

COMMENT ON COLUMN public.cdss_recommendations.doctor_response IS
  'pending = shown but not yet actioned; accepted = doctor used the suggestion; '
  'ignored = doctor explicitly dismissed it';
