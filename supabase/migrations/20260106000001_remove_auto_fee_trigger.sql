-- Migration: Remove auto_add_consultation_fee trigger
-- Description: Drops the legacy trigger that automatically adds consultation fees on visit creation.
-- This trigger conflicts with the new explicit service selection logic in register_patient_with_visit.

-- 1. Drop the trigger from the visits table
DROP TRIGGER IF EXISTS trigger_auto_add_consultation_fee ON public.visits;

-- 2. Drop the function itself
DROP FUNCTION IF EXISTS public.auto_add_consultation_fee();

-- 3. Cleanup any inconsistent billing items (Optional but recommended for affected records)
-- (We will not do this automatically to avoid deleting valid history, 
-- but we stop the bleeding for new records.)
