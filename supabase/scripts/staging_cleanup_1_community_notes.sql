-- ─── Staging fix 1: Apply community_notes migration ──────────────────────────
--
-- IMPORTANT: Run this in TWO separate executions in the SQL editor.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- STEP A — Run this block FIRST, then click "Run" and wait for it to succeed.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'hew';

-- After this succeeds, clear the editor and paste + run STEP B below.

-- ══════════════════════════════════════════════════════════════════════════════
-- STEP B — Run this block in a SECOND execution (after STEP A is committed).
-- ══════════════════════════════════════════════════════════════════════════════

-- Note type enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'community_note_type') THEN
    CREATE TYPE public.community_note_type AS ENUM (
      'general',
      'household_visit',
      'maternal_followup',
      'child_growth',
      'vaccination',
      'referral_followup',
      'nutrition',
      'medication_adherence'
    );
  END IF;
END $$;

-- Community notes table
CREATE TABLE IF NOT EXISTS public.community_notes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid        NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  visit_id        uuid        REFERENCES public.visits(id) ON DELETE SET NULL,
  author_id       uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  facility_id     uuid        REFERENCES public.facilities(id) ON DELETE CASCADE,
  tenant_id       uuid        REFERENCES public.tenants(id) ON DELETE CASCADE,
  note_type       public.community_note_type NOT NULL DEFAULT 'general',
  note_text       text        NOT NULL CHECK (char_length(note_text) BETWEEN 1 AND 4000),
  visit_date      date        NOT NULL DEFAULT CURRENT_DATE,
  location        text,
  follow_up_due   date,
  flags           text[]      DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_community_notes_patient_id  ON public.community_notes(patient_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_author_id   ON public.community_notes(author_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_facility_id ON public.community_notes(facility_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_visit_date  ON public.community_notes(visit_date DESC);

-- Auto-update trigger
CREATE OR REPLACE FUNCTION public.set_community_notes_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_community_notes_updated_at ON public.community_notes;
CREATE TRIGGER trg_community_notes_updated_at
  BEFORE UPDATE ON public.community_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_community_notes_updated_at();

-- RLS
ALTER TABLE public.community_notes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='community_notes' AND policyname='hew_read_facility_notes') THEN
    CREATE POLICY "hew_read_facility_notes" ON public.community_notes FOR SELECT
      USING (EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.auth_user_id = auth.uid()
          AND u.user_role = 'hew'
          AND u.facility_id = community_notes.facility_id
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='community_notes' AND policyname='hew_insert_notes') THEN
    CREATE POLICY "hew_insert_notes" ON public.community_notes FOR INSERT
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.auth_user_id = auth.uid()
          AND u.user_role = 'hew'
          AND u.facility_id = community_notes.facility_id
          AND u.id = community_notes.author_id
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='community_notes' AND policyname='clinical_read_facility_notes') THEN
    CREATE POLICY "clinical_read_facility_notes" ON public.community_notes FOR SELECT
      USING (EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.auth_user_id = auth.uid()
          AND u.user_role IN ('doctor','nurse','clinical_officer','admin','super_admin','medical_director')
          AND u.facility_id = community_notes.facility_id
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='community_notes' AND policyname='service_role_all') THEN
    CREATE POLICY "service_role_all" ON public.community_notes FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

SELECT 'community_notes migration applied ✓' AS result;
