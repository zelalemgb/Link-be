-- Add missing country column to clinic_registrations
ALTER TABLE public.clinic_registrations ADD COLUMN country TEXT;