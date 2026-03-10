-- Add operating schedule fields for departments (OPD working days/hours)
ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS operating_days TEXT[],
  ADD COLUMN IF NOT EXISTS opens_at TIME,
  ADD COLUMN IF NOT EXISTS closes_at TIME,
  ADD COLUMN IF NOT EXISTS is_24h BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.departments.operating_days IS 'Days of week department is open (e.g., {Mon,Tue,Wed})';
COMMENT ON COLUMN public.departments.opens_at IS 'Opening time for the department schedule';
COMMENT ON COLUMN public.departments.closes_at IS 'Closing time for the department schedule';
COMMENT ON COLUMN public.departments.is_24h IS 'Whether the department operates 24 hours';
