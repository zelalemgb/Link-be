-- Enable real-time for visits table (set replica identity only)
ALTER TABLE public.visits REPLICA IDENTITY FULL;