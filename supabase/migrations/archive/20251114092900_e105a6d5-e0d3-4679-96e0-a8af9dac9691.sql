-- Add phone_number column to staff_invitations table
ALTER TABLE public.staff_invitations 
ADD COLUMN IF NOT EXISTS phone_number TEXT;