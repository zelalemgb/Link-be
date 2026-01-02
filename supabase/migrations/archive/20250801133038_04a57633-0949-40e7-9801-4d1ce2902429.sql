-- Add visit_notes column to support clinical documentation
ALTER TABLE public.visits 
ADD COLUMN visit_notes TEXT;