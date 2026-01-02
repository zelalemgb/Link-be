-- Reinstate refresh triggers so nurse_dashboard_queue stays in sync when vitals or orders change
CREATE OR REPLACE FUNCTION public.refresh_nurse_dashboard_queue()
RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.nurse_dashboard_queue;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

COMMENT ON FUNCTION public.refresh_nurse_dashboard_queue()
IS 'Auto-refreshes nurse_dashboard_queue materialized view when related data changes';

-- Drop old trigger names if they exist
DROP TRIGGER IF EXISTS refresh_dashboard_on_visit ON public.visits;
DROP TRIGGER IF EXISTS refresh_dashboard_on_billing ON public.billing_items;
DROP TRIGGER IF EXISTS refresh_dashboard_on_lab ON public.lab_orders;
DROP TRIGGER IF EXISTS refresh_dashboard_on_imaging ON public.imaging_orders;
DROP TRIGGER IF EXISTS refresh_dashboard_on_medication ON public.medication_orders;
DROP TRIGGER IF EXISTS refresh_dashboard_on_patients ON public.patients;
DROP TRIGGER IF EXISTS refresh_dashboard_on_payments ON public.payments;
DROP TRIGGER IF EXISTS refresh_dashboard_on_payment_items ON public.payment_line_items;

-- Visits drive vitals/triage updates
CREATE TRIGGER refresh_dashboard_on_visit
  AFTER INSERT OR UPDATE OR DELETE ON public.visits
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

-- Patient demographics displayed directly in queue
CREATE TRIGGER refresh_dashboard_on_patients
  AFTER INSERT OR UPDATE OR DELETE ON public.patients
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

-- Orders and services influence payment flags/status
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

CREATE TRIGGER refresh_dashboard_on_payments
  AFTER INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

CREATE TRIGGER refresh_dashboard_on_payment_items
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_line_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

-- Prime latest snapshot
REFRESH MATERIALIZED VIEW public.nurse_dashboard_queue;
