BEGIN;

-- Ensure the trigger function exists for updating updated_at columns
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Guarantee payments.updated_at has a default and is not null
ALTER TABLE public.payments
  ALTER COLUMN updated_at SET DEFAULT now();

UPDATE public.payments
SET updated_at = now()
WHERE updated_at IS NULL;

-- Recreate the trigger so payments.updated_at is refreshed automatically
DROP TRIGGER IF EXISTS update_payments_updated_at ON public.payments;

CREATE TRIGGER update_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

COMMIT;
