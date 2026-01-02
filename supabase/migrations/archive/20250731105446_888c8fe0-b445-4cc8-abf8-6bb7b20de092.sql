-- Update function to generate clinic code using first two letters of clinic name
CREATE OR REPLACE FUNCTION public.generate_clinic_code(clinic_name_input text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  code TEXT;
  exists_check BOOLEAN;
  name_prefix TEXT;
BEGIN
  -- Extract first two letters from clinic name, convert to uppercase
  name_prefix := upper(regexp_replace(clinic_name_input, '[^A-Za-z]', '', 'g'));
  
  -- If name has less than 2 letters, pad with 'X'
  IF length(name_prefix) < 2 THEN
    name_prefix := rpad(name_prefix, 2, 'X');
  ELSE
    name_prefix := left(name_prefix, 2);
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

-- Update trigger to pass clinic name to the function
CREATE OR REPLACE FUNCTION public.auto_generate_clinic_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.clinic_code IS NULL OR NEW.clinic_code = '' THEN
    NEW.clinic_code := generate_clinic_code(NEW.name);
  END IF;
  RETURN NEW;
END;
$$;