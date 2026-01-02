-- Add triage-related fields to visits table
ALTER TABLE public.visits 
ADD COLUMN IF NOT EXISTS triage_triggers TEXT[], 
ADD COLUMN IF NOT EXISTS triage_urgency TEXT,
ADD COLUMN IF NOT EXISTS triage_followup_responses JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS clinical_notes TEXT;