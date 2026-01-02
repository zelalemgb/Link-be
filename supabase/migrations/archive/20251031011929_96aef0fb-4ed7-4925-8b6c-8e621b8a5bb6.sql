-- Add fayida_id column to patients table
ALTER TABLE public.patients
ADD COLUMN fayida_id TEXT;

-- Add comment explaining the field
COMMENT ON COLUMN public.patients.fayida_id IS 'Ethiopian Digital ID (Fayida) - Format: 16 digits';

-- Create index for faster lookups
CREATE INDEX idx_patients_fayida_id ON public.patients(fayida_id) WHERE fayida_id IS NOT NULL;