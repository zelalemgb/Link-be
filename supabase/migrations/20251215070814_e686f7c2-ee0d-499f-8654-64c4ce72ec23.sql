-- Add activation_status to facilities table to distinguish testing vs active clinics
ALTER TABLE public.facilities 
ADD COLUMN IF NOT EXISTS activation_status text NOT NULL DEFAULT 'testing';

-- Add comment for clarity
COMMENT ON COLUMN public.facilities.activation_status IS 'Status of facility activation: testing (beta/trial), active (full access), suspended';

-- Update existing verified facilities to be active
UPDATE public.facilities 
SET activation_status = 'active' 
WHERE verified = true AND verification_status = 'approved';

-- Update pending facilities to testing status (they'll become testing when approved)
UPDATE public.facilities 
SET activation_status = 'testing' 
WHERE verification_status = 'pending';