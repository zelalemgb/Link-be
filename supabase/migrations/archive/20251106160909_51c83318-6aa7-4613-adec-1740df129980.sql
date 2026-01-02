-- Ensure RLS is enabled (safe if already enabled)
ALTER TABLE public.feature_requests ENABLE ROW LEVEL SECURITY;

-- Allow users to delete their own feature requests permanently
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'feature_requests' 
      AND policyname = 'Users can delete own feature requests'
  ) THEN
    CREATE POLICY "Users can delete own feature requests"
    ON public.feature_requests
    FOR DELETE
    USING (
      user_id IN (
        SELECT u.id FROM public.users u WHERE u.auth_user_id = auth.uid()
      )
    );
  END IF;
END $$;

-- Allow users to update their own feature requests (needed for soft-delete fallback)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'feature_requests' 
      AND policyname = 'Users can update own feature requests'
  ) THEN
    CREATE POLICY "Users can update own feature requests"
    ON public.feature_requests
    FOR UPDATE
    USING (
      user_id IN (
        SELECT u.id FROM public.users u WHERE u.auth_user_id = auth.uid()
      )
    )
    WITH CHECK (
      user_id IN (
        SELECT u.id FROM public.users u WHERE u.auth_user_id = auth.uid()
      )
    );
  END IF;
END $$;

-- Optional: Ensure owners can select their own requests if not already allowed
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
      AND tablename = 'feature_requests' 
      AND policyname = 'Users can view own feature requests'
  ) THEN
    CREATE POLICY "Users can view own feature requests"
    ON public.feature_requests
    FOR SELECT
    USING (
      user_id IN (
        SELECT u.id FROM public.users u WHERE u.auth_user_id = auth.uid()
      )
    );
  END IF;
END $$;