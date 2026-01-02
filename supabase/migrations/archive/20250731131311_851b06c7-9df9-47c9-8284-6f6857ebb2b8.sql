-- Fix the trigger function to properly call generate_clinic_code
DROP TRIGGER IF EXISTS auto_generate_clinic_code_trigger ON public.facilities;
DROP FUNCTION IF EXISTS public.auto_generate_clinic_code();

-- Create the trigger function that properly calls generate_clinic_code
CREATE OR REPLACE FUNCTION public.auto_generate_clinic_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF NEW.clinic_code IS NULL OR NEW.clinic_code = '' THEN
    NEW.clinic_code := public.generate_clinic_code(NEW.name);
  END IF;
  RETURN NEW;
END;
$$;

-- Create the trigger
CREATE TRIGGER auto_generate_clinic_code_trigger
  BEFORE INSERT ON public.facilities
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_generate_clinic_code();