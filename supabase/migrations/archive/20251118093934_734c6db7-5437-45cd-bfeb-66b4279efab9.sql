-- Drop triggers that refresh nurse_dashboard_queue (no longer needed for regular view)
DROP TRIGGER IF EXISTS trigger_refresh_dashboard_on_visit ON public.visits;
DROP TRIGGER IF EXISTS trigger_refresh_dashboard_on_billing ON public.billing_items;
DROP TRIGGER IF EXISTS refresh_dashboard_on_visit ON public.visits;
DROP TRIGGER IF EXISTS refresh_dashboard_on_billing ON public.billing_items;
DROP TRIGGER IF EXISTS refresh_dashboard_on_lab ON public.lab_orders;
DROP TRIGGER IF EXISTS refresh_dashboard_on_imaging ON public.imaging_orders;
DROP TRIGGER IF EXISTS refresh_dashboard_on_medication ON public.medication_orders;

-- Drop the refresh function (no longer needed for regular view)
DROP FUNCTION IF EXISTS public.refresh_nurse_dashboard_queue() CASCADE;
DROP FUNCTION IF EXISTS public.refresh_dashboard_view() CASCADE;

COMMENT ON VIEW public.nurse_dashboard_queue IS 'Real-time view of nurse dashboard queue - auto-updates without manual refresh. Replaces previous materialized view implementation.';