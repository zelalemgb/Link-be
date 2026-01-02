-- Add clinic_code column to facilities table
ALTER TABLE public.facilities ADD COLUMN clinic_code text UNIQUE;

-- Create function to generate unique clinic code
CREATE OR REPLACE FUNCTION public.generate_clinic_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  code TEXT;
  exists_check BOOLEAN;
BEGIN
  LOOP
    -- Generate 6-character alphanumeric code (letters and numbers)
    code := upper(
      chr(trunc(random() * 26)::int + 65) ||  -- First letter
      chr(trunc(random() * 26)::int + 65) ||  -- Second letter
      trunc(random() * 10)::text ||           -- First number
      trunc(random() * 10)::text ||           -- Second number
      chr(trunc(random() * 26)::int + 65) ||  -- Third letter
      trunc(random() * 10)::text              -- Third number
    );
    
    -- Check if code already exists
    SELECT EXISTS(SELECT 1 FROM public.facilities WHERE clinic_code = code) INTO exists_check;
    
    -- Exit loop if code is unique
    EXIT WHEN NOT exists_check;
  END LOOP;
  
  RETURN code;
END;
$$;

-- Create trigger to auto-generate clinic code when facility is created
CREATE OR REPLACE FUNCTION public.auto_generate_clinic_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.clinic_code IS NULL OR NEW.clinic_code = '' THEN
    NEW.clinic_code := generate_clinic_code();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_auto_generate_clinic_code
  BEFORE INSERT ON public.facilities
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_generate_clinic_code();