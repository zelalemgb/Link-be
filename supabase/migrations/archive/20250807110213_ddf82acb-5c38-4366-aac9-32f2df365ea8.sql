-- Fix search path for security function
CREATE OR REPLACE FUNCTION public.update_visit_status_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  -- Update status_updated_at when status changes
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.status_updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;