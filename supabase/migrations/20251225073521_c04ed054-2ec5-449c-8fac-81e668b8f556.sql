-- Add code column to medical_services table
ALTER TABLE public.medical_services ADD COLUMN IF NOT EXISTS code text;