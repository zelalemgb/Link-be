-- ============================================================
-- FIX 25: Local AI Knowledge Base
-- ============================================================
-- Persists anonymised clinical cases used for RAG (Retrieval-
-- Augmented Generation) in the local Ollama AI service.
--
-- Why: ChromaDB stores embeddings on the ML service filesystem.
-- This table provides a durable backup so the knowledge base
-- can be re-seeded after a service restart or server migration,
-- without losing cases accumulated from provider feedback.
--
-- Privacy: NO patient identifiers stored here. Cases are
-- anonymised at the application layer before insertion.
-- ============================================================

-- ── clinical_knowledge_base ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clinical_knowledge_base (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id     UUID        REFERENCES public.facilities(id) ON DELETE SET NULL,

  -- Case classification
  case_type       TEXT        NOT NULL CHECK (case_type IN ('diagnosis','treatment','diagnostic_test','guideline')),
  age_group       TEXT        NOT NULL CHECK (age_group IN ('adult','pediatric','maternal','neonatal')),
  gender          TEXT,
  facility_type   TEXT        CHECK (facility_type IN ('health_post','health_centre','primary_hospital','general_hospital')),

  -- Anonymised clinical content (no PII)
  chief_complaint     TEXT    NOT NULL,
  symptoms            TEXT[], -- array of symptom keywords
  diagnosis_accepted  TEXT    NOT NULL,
  treatment_accepted  TEXT    NOT NULL,
  provider_correction TEXT,   -- what the provider changed from AI suggestion
  outcome_notes       TEXT,

  -- Quality signals
  provider_action TEXT    NOT NULL DEFAULT 'accepted'
                          CHECK (provider_action IN ('accepted','modified','rejected')),
  confidence_score NUMERIC(4,3) CHECK (confidence_score BETWEEN 0 AND 1),

  -- Sync state
  synced_to_rag   BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE once embedded into ChromaDB
  row_version     BIGINT  NOT NULL DEFAULT 1,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_ckb_tenant_facility
  ON public.clinical_knowledge_base (tenant_id, facility_id);

CREATE INDEX IF NOT EXISTS idx_ckb_case_type
  ON public.clinical_knowledge_base (case_type);

CREATE INDEX IF NOT EXISTS idx_ckb_age_group
  ON public.clinical_knowledge_base (age_group);

CREATE INDEX IF NOT EXISTS idx_ckb_unsynced
  ON public.clinical_knowledge_base (synced_to_rag)
  WHERE synced_to_rag = FALSE;

CREATE INDEX IF NOT EXISTS idx_ckb_diagnosis
  ON public.clinical_knowledge_base (diagnosis_accepted);

-- Row-version bump trigger (offline sync support)
CREATE OR REPLACE FUNCTION public.bump_ckb_row_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_at  := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ckb_row_version ON public.clinical_knowledge_base;
CREATE TRIGGER trg_ckb_row_version
  BEFORE UPDATE ON public.clinical_knowledge_base
  FOR EACH ROW EXECUTE FUNCTION public.bump_ckb_row_version();

-- RLS
ALTER TABLE public.clinical_knowledge_base ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_ckb" ON public.clinical_knowledge_base;
CREATE POLICY "tenant_isolation_ckb" ON public.clinical_knowledge_base
  USING (tenant_id = (
    SELECT tenant_id FROM public.users
    WHERE id = auth.uid() LIMIT 1
  ));

-- ── ai_service_config ─────────────────────────────────────────
-- Stores per-tenant AI service configuration so the backend
-- knows which local AI endpoint to call for each tenant.
CREATE TABLE IF NOT EXISTS public.ai_service_config (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- Local AI service
  local_ai_url     TEXT        NOT NULL DEFAULT 'http://127.0.0.1:8000',
  ollama_model     TEXT        NOT NULL DEFAULT 'mistral:7b-instruct',
  rag_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  rag_top_k        INTEGER     NOT NULL DEFAULT 3 CHECK (rag_top_k BETWEEN 1 AND 10),

  -- CDSS
  cdss_ai_advisory_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- Feature flags
  vision_enabled   BOOLEAN     NOT NULL DEFAULT FALSE,

  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID        REFERENCES public.users(id)
);

ALTER TABLE public.ai_service_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_ai_config" ON public.ai_service_config;
CREATE POLICY "tenant_isolation_ai_config" ON public.ai_service_config
  USING (tenant_id = (
    SELECT tenant_id FROM public.users
    WHERE id = auth.uid() LIMIT 1
  ));

-- ── Comments ──────────────────────────────────────────────────
COMMENT ON TABLE public.clinical_knowledge_base IS
  'Anonymised accepted AI clinical cases used for RAG (local Ollama AI service). No patient PII stored.';

COMMENT ON TABLE public.ai_service_config IS
  'Per-tenant local AI service configuration (Ollama model, RAG settings, CDSS flags).';

COMMENT ON COLUMN public.clinical_knowledge_base.synced_to_rag IS
  'Set to TRUE once the case has been embedded into the local ChromaDB vector store. Unsynced cases can be re-seeded after a service restart.';
