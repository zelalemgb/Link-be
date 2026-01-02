-- Enable RLS on users table (safe if already enabled)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Allow staff to view clinicians (doctors and clinical officers) in their own facility
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'users' 
      AND policyname = 'Staff can view clinicians in facility'
  ) THEN
    CREATE POLICY "Staff can view clinicians in facility"
    ON public.users
    FOR SELECT
    USING (
      facility_id = public.get_user_facility_id()
      AND user_role IN ('doctor', 'clinical_officer')
    );
  END IF;
END$$;

-- Ensure users can also see themselves (useful for context lookups)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'users' 
      AND policyname = 'Users can view self'
  ) THEN
    CREATE POLICY "Users can view self"
    ON public.users
    FOR SELECT
    USING (auth_user_id = auth.uid());
  END IF;
END$$;
