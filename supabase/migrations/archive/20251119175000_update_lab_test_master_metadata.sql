-- Add extended metadata fields to lab_test_master
ALTER TABLE public.lab_test_master
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS panic_low TEXT,
  ADD COLUMN IF NOT EXISTS panic_high TEXT,
  ADD COLUMN IF NOT EXISTS delta_check_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS delta_check_hours INTEGER,
  ADD COLUMN IF NOT EXISTS delta_check_notes TEXT,
  ADD COLUMN IF NOT EXISTS guideline_source TEXT;

COMMENT ON COLUMN public.lab_test_master.description IS 'Brief clinical description of the analyte or the utility of the test';
COMMENT ON COLUMN public.lab_test_master.panic_low IS 'Threshold value that should trigger a panic/critical alert on the low end';
COMMENT ON COLUMN public.lab_test_master.panic_high IS 'Threshold value that should trigger a panic/critical alert on the high end';
COMMENT ON COLUMN public.lab_test_master.delta_check_percent IS 'Percent change that should raise a delta-check alert compared to the previous result';
COMMENT ON COLUMN public.lab_test_master.delta_check_hours IS 'Lookback window (hours) used for delta checking';
COMMENT ON COLUMN public.lab_test_master.delta_check_notes IS 'Human-readable notes for how delta checking should be applied';
COMMENT ON COLUMN public.lab_test_master.guideline_source IS 'Primary reference used to derive the reference range/panic values';
