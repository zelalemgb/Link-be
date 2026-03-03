-- Phase 1: HEW (Health Extension Worker) role + Community Memory Layer
-- Adds the 'hew' user_role enum value and creates the community_notes table
-- that allows HEWs to log field observations against a patient record.
-- Doctors can read HEW notes in the pre-consultation hypothesis view.

-- ─── 1. Extend user_role enum ──────────────────────────────────────────────────
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'hew';

-- ─── 2. Note type enum ────────────────────────────────────────────────────────
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

-- ─── 3. Community notes table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.community_notes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      uuid        NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  visit_id        uuid        REFERENCES public.visits(id) ON DELETE SET NULL,
  author_id       uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  facility_id     uuid        REFERENCES public.facilities(id) ON DELETE CASCADE,
  tenant_id       uuid        REFERENCES public.tenants(id) ON DELETE CASCADE,

  note_type       public.community_note_type NOT NULL DEFAULT 'general',
  note_text       text        NOT NULL CHECK (char_length(note_text) BETWEEN 1 AND 4000),

  -- Structured fields for common HEW observations (nullable, filled by note_type)
  visit_date      date        NOT NULL DEFAULT CURRENT_DATE,
  location        text,                        -- village / kebele
  follow_up_due   date,                        -- next scheduled HEW visit
  flags           text[]      DEFAULT '{}',    -- e.g. ['danger_sign', 'missed_dose']

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_community_notes_patient_id   ON public.community_notes(patient_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_visit_id     ON public.community_notes(visit_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_author_id    ON public.community_notes(author_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_facility_id  ON public.community_notes(facility_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_visit_date   ON public.community_notes(visit_date DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_community_notes_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_community_notes_updated_at
  BEFORE UPDATE ON public.community_notes
  FOR EACH ROW EXECUTE FUNCTION public.set_community_notes_updated_at();

-- ─── 4. Row Level Security ────────────────────────────────────────────────────
ALTER TABLE public.community_notes ENABLE ROW LEVEL SECURITY;

-- HEWs can read all notes for their facility
CREATE POLICY "hew_read_facility_notes"
  ON public.community_notes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role = 'hew'
        AND u.facility_id = community_notes.facility_id
    )
  );

-- HEWs can insert notes for their facility
CREATE POLICY "hew_insert_notes"
  ON public.community_notes FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role = 'hew'
        AND u.facility_id = community_notes.facility_id
        AND u.id = community_notes.author_id
    )
  );

-- HEWs can update their own notes (within 24 hours)
CREATE POLICY "hew_update_own_recent_notes"
  ON public.community_notes FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.id = community_notes.author_id
        AND u.user_role = 'hew'
    )
    AND community_notes.created_at > now() - INTERVAL '24 hours'
  );

-- Clinical staff (doctors, nurses, clinical officers) can read notes for their facility
CREATE POLICY "clinical_read_facility_notes"
  ON public.community_notes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.user_role IN ('doctor', 'nurse', 'clinical_officer', 'admin', 'super_admin', 'medical_director')
        AND u.facility_id = community_notes.facility_id
    )
  );

-- Service-role bypass (backend admin client can do anything)
CREATE POLICY "service_role_all"
  ON public.community_notes FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── 5. Comments ──────────────────────────────────────────────────────────────
COMMENT ON TABLE  public.community_notes                IS 'Field observations logged by Health Extension Workers (HEWs). Visible to clinical staff during pre-consultation.';
COMMENT ON COLUMN public.community_notes.note_type      IS 'Category of HEW community interaction.';
COMMENT ON COLUMN public.community_notes.flags          IS 'Danger signs or adherence flags raised by the HEW (e.g. danger_sign, missed_dose, defaulted).';
COMMENT ON COLUMN public.community_notes.follow_up_due  IS 'Date the HEW plans to visit the patient again.';
COMMENT ON COLUMN public.community_notes.location       IS 'Kebele or village where the home visit occurred.';
