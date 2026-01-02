-- Tighten patient data visibility to enforce facility isolation and remove unauthenticated access
DO $$ BEGIN
  ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY; 
EXCEPTION WHEN others THEN NULL; END $$;

-- Remove overly permissive policy if it exists
DROP POLICY IF EXISTS "Allow patient viewing for authenticated users" ON public.patients;

-- Enforce strict facility-based visibility for authenticated users
CREATE POLICY "Facility staff can view patients in their facility"
ON public.patients
FOR SELECT
TO authenticated
USING (
  -- Staff/Admin see only their facility's patients
  facility_id = public.get_user_facility_id()
  -- Or the records they created (covers initial intake scenarios)
  OR created_by IN (
    SELECT u.id FROM public.users u WHERE u.auth_user_id = auth.uid()
  )
);

-- Document rationale
COMMENT ON POLICY "Facility staff can view patients in their facility" ON public.patients IS 
'Removes unauthenticated access and ensures authenticated users only see patients from their own facility or ones they created.';