-- Enable real-time updates for visits table
-- This ensures that dashboards get immediate updates when new visits are created

-- Set REPLICA IDENTITY FULL to capture complete row data during updates
ALTER TABLE public.visits REPLICA IDENTITY FULL;

-- Add the visits table to the supabase_realtime publication to activate real-time functionality
-- This allows real-time subscriptions to work properly
DO $$
BEGIN
  -- Check if the publication exists, if not create it
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  
  -- Add visits table to the publication if not already added
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND tablename = 'visits'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.visits;
  END IF;
END $$;