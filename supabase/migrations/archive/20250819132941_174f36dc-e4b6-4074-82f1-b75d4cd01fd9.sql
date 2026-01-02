-- Add doctor assignment and OPD room fields to visits table
ALTER TABLE public.visits 
ADD COLUMN assigned_doctor UUID REFERENCES public.users(id),
ADD COLUMN opd_room TEXT;