-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: SMS Pre-Triage requests table
-- Phase 1 – Africa's Talking inbound SMS intake
-- ─────────────────────────────────────────────────────────────────────────────

-- Pre-triage status lifecycle: pending → triaged → linked | expired
CREATE TYPE public.pretriage_status AS ENUM (
  'pending',   -- SMS received, awaiting triage processing
  'triaged',   -- AI/rule-based urgency assigned, reply sent
  'linked',    -- Visit created and linked to this pre-triage record
  'expired'    -- No visit created within 24h; archived
);

-- ─── pre_triage_requests ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pre_triage_requests (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id       uuid        NOT NULL REFERENCES public.facilities(id),
  tenant_id         uuid        NOT NULL REFERENCES public.tenants(id),

  -- Sender info (from Africa's Talking webhook)
  phone_number      text        NOT NULL,          -- E.164 format, e.g. +251912345678
  network_code      text,                           -- AT operator code (optional)
  at_message_id     text        UNIQUE,             -- Africa's Talking msgId (dedup key)

  -- Raw & parsed content
  raw_message       text        NOT NULL,
  parsed_symptoms   text[],                         -- extracted symptom keywords
  parsed_language   text        DEFAULT 'en',       -- 'en' | 'am' (Amharic) | 'om' (Oromo)

  -- AI output
  recommended_urgency text      CHECK (recommended_urgency IN ('emergency', 'urgent', 'routine', 'unknown')),
  recommended_cohort  text      CHECK (recommended_cohort IN ('adult', 'pediatric', 'maternal')),
  ai_summary          text,                         -- one-line summary for triage display

  -- Reply tracking
  reply_sent        boolean     NOT NULL DEFAULT false,
  reply_text        text,
  reply_sent_at     timestamptz,

  -- Linkage (populated when a visit is registered for this patient)
  linked_patient_id uuid        REFERENCES public.patients(id),
  linked_visit_id   uuid        REFERENCES public.visits(id),

  status            pretriage_status NOT NULL DEFAULT 'pending',

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pretriage_facility
  ON public.pre_triage_requests(facility_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pretriage_phone
  ON public.pre_triage_requests(phone_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pretriage_status
  ON public.pre_triage_requests(status, facility_id);

CREATE INDEX IF NOT EXISTS idx_pretriage_linked_visit
  ON public.pre_triage_requests(linked_visit_id)
  WHERE linked_visit_id IS NOT NULL;

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_pretriage_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pretriage_updated_at
  BEFORE UPDATE ON public.pre_triage_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_pretriage_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.pre_triage_requests ENABLE ROW LEVEL SECURITY;

-- Reception & triage staff read within their facility
CREATE POLICY pretriage_clinical_read ON public.pre_triage_requests
  FOR SELECT
  USING (
    facility_id IN (
      SELECT facility_id FROM public.staff WHERE auth_user_id = auth.uid()
    )
  );

-- Only service_role writes (webhook server uses service_role key)
CREATE POLICY pretriage_service_role_all ON public.pre_triage_requests
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
