-- Auto-update visit status when consultation billing_items are paid
-- This trigger ensures that when a consultation service is paid, the visit status
-- automatically updates to 'at_triage' so nurses see the patient immediately

CREATE OR REPLACE FUNCTION public.auto_update_visit_status_on_consultation_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service_category text;
BEGIN
  -- Only process when payment_status changes to 'paid'
  IF NEW.payment_status = 'paid' AND (OLD.payment_status IS NULL OR OLD.payment_status != 'paid') THEN
    
    -- Check if this is a consultation service
    SELECT ms.category INTO v_service_category
    FROM public.medical_services ms
    WHERE ms.id = NEW.service_id;
    
    IF v_service_category = 'Consultation' THEN
      -- Update visit status to at_triage and set fee_paid
      UPDATE public.visits
      SET status = 'at_triage',
          status_updated_at = now(),
          fee_paid = NEW.total_amount
      WHERE id = NEW.visit_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_auto_update_visit_status_on_consultation_payment
  AFTER UPDATE ON public.billing_items
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_update_visit_status_on_consultation_payment();