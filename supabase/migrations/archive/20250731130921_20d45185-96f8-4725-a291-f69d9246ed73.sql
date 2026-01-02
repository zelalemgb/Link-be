-- Fix the generate_clinic_code function that's missing the text parameter
DROP FUNCTION IF EXISTS public.generate_clinic_code();

-- Create the correct version that takes clinic name as parameter
CREATE OR REPLACE FUNCTION public.generate_clinic_code(clinic_name_input text DEFAULT '')
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  code TEXT;
  exists_check BOOLEAN;
  name_prefix TEXT;
BEGIN
  -- Extract first two letters from clinic name, convert to uppercase
  IF clinic_name_input IS NOT NULL AND length(clinic_name_input) > 0 THEN
    name_prefix := upper(regexp_replace(clinic_name_input, '[^A-Za-z]', '', 'g'));
    
    -- If name has less than 2 letters, pad with 'C' for Clinic
    IF length(name_prefix) < 2 THEN
      name_prefix := rpad(coalesce(name_prefix, 'C'), 2, 'C');
    ELSE
      name_prefix := left(name_prefix, 2);
    END IF;
  ELSE
    -- Default prefix if no clinic name provided
    name_prefix := 'CL';
  END IF;
  
  LOOP
    -- Generate code with clinic name prefix + 2 numbers + 1 letter + 1 number
    code := name_prefix ||
            trunc(random() * 10)::text ||           -- First number
            trunc(random() * 10)::text ||           -- Second number  
            chr(trunc(random() * 26)::int + 65) ||  -- Letter
            trunc(random() * 10)::text;             -- Third number
    
    -- Check if code already exists
    SELECT EXISTS(SELECT 1 FROM public.facilities WHERE clinic_code = code) INTO exists_check;
    
    -- Exit loop if code is unique
    EXIT WHEN NOT exists_check;
  END LOOP;
  
  RETURN code;
END;
$$;

-- Update the trigger to properly call the function
DROP TRIGGER IF EXISTS auto_generate_clinic_code_trigger ON public.facilities;

CREATE OR REPLACE FUNCTION public.auto_generate_clinic_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF NEW.clinic_code IS NULL OR NEW.clinic_code = '' THEN
    NEW.clinic_code := generate_clinic_code(NEW.name);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER auto_generate_clinic_code_trigger
  BEFORE INSERT ON public.facilities
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_generate_clinic_code();