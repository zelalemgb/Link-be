-- Add BEFORE INSERT trigger to set user_id and facility_id from auth context
CREATE OR REPLACE FUNCTION public.set_feature_request_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- Map auth user to public.users.id
  SELECT id INTO v_user_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;

  IF NEW.user_id IS NULL THEN
    NEW.user_id := v_user_id;
  END IF;

  IF NEW.facility_id IS NULL THEN
    NEW.facility_id := public.get_user_facility_id();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_feature_requests_defaults ON public.feature_requests;
CREATE TRIGGER trg_feature_requests_defaults
BEFORE INSERT ON public.feature_requests
FOR EACH ROW
EXECUTE FUNCTION public.set_feature_request_defaults();

-- Loosen INSERT policy to authenticated users; trigger assigns user_id
DROP POLICY IF EXISTS "Users can create feature requests" ON public.feature_requests;
CREATE POLICY "Users can create feature requests"
ON public.feature_requests FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL);