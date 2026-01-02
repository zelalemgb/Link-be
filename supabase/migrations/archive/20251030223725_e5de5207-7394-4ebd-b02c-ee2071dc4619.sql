-- Add Ethiopian address fields to patients table
ALTER TABLE public.patients
ADD COLUMN IF NOT EXISTS region text,
ADD COLUMN IF NOT EXISTS woreda_subcity text,
ADD COLUMN IF NOT EXISTS ketena_gott text,
ADD COLUMN IF NOT EXISTS kebele text,
ADD COLUMN IF NOT EXISTS house_number text;

-- Add index for region queries
CREATE INDEX IF NOT EXISTS idx_patients_region ON public.patients(region);
CREATE INDEX IF NOT EXISTS idx_patients_kebele ON public.patients(kebele);