-- Create or replace function to refresh materialized view
CREATE OR REPLACE FUNCTION public.refresh_nurse_dashboard_queue()
RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.nurse_dashboard_queue;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS refresh_dashboard_on_visit ON public.visits;
DROP TRIGGER IF EXISTS refresh_dashboard_on_billing ON public.billing_items;
DROP TRIGGER IF EXISTS refresh_dashboard_on_lab ON public.lab_orders;
DROP TRIGGER IF EXISTS refresh_dashboard_on_imaging ON public.imaging_orders;
DROP TRIGGER IF EXISTS refresh_dashboard_on_medication ON public.medication_orders;

-- Create triggers to auto-refresh materialized view on key table changes
CREATE TRIGGER refresh_dashboard_on_visit
  AFTER INSERT OR UPDATE OR DELETE ON public.visits
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

CREATE TRIGGER refresh_dashboard_on_billing
  AFTER INSERT OR UPDATE OR DELETE ON public.billing_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

CREATE TRIGGER refresh_dashboard_on_lab
  AFTER INSERT OR UPDATE OR DELETE ON public.lab_orders
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

CREATE TRIGGER refresh_dashboard_on_imaging
  AFTER INSERT OR UPDATE OR DELETE ON public.imaging_orders
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

CREATE TRIGGER refresh_dashboard_on_medication
  AFTER INSERT OR UPDATE OR DELETE ON public.medication_orders
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

COMMENT ON FUNCTION public.refresh_nurse_dashboard_queue() IS 'Auto-refreshes nurse_dashboard_queue materialized view when related data changes';
