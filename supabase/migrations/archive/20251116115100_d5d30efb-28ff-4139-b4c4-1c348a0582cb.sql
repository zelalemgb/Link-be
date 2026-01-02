-- Add payment type fields to visits table
ALTER TABLE public.visits 
  ADD COLUMN IF NOT EXISTS consultation_payment_type TEXT DEFAULT 'paying',
  ADD COLUMN IF NOT EXISTS insurance_provider TEXT,
  ADD COLUMN IF NOT EXISTS insurance_policy_number TEXT;

-- Add check constraint for valid payment types
ALTER TABLE public.visits 
  ADD CONSTRAINT visits_payment_type_check 
  CHECK (consultation_payment_type IN ('paying', 'free', 'credit', 'insured'));

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_visits_payment_type ON public.visits(consultation_payment_type);

-- Add comment
COMMENT ON COLUMN public.visits.consultation_payment_type IS 'Payment arrangement for consultation: paying (requires upfront payment), free (no payment), credit (deferred payment), insured (covered by insurance)';