-- Fix: Auto-update visit status when payment record is marked as paid
-- Drop old triggers that don't fire correctly
DROP TRIGGER IF EXISTS auto_update_visit_status_medication ON public.medication_orders;
DROP TRIGGER IF EXISTS auto_update_visit_status_lab ON public.lab_orders;
DROP TRIGGER IF EXISTS auto_update_visit_status_imaging ON public.imaging_orders;
DROP TRIGGER IF EXISTS auto_update_visit_status_billing ON public.billing_items;

-- Create new trigger on payments table that actually gets updated by the RPC
CREATE OR REPLACE FUNCTION auto_update_visit_on_payment_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_visit_status TEXT;
  v_next_stage TEXT;
BEGIN
  -- Only proceed when payment becomes fully paid
  IF NEW.payment_status = 'paid' AND (OLD.payment_status IS DISTINCT FROM 'paid') THEN
    -- Get current visit status
    SELECT status INTO v_visit_status
    FROM visits
    WHERE id = NEW.visit_id;
    
    -- Only update if visit is in a paying stage
    IF v_visit_status IN ('paying_consultation', 'paying_diagnosis', 'paying_pharmacy') THEN
      -- Determine next stage based on current status
      v_next_stage := determine_next_stage_after_payment(NEW.visit_id, v_visit_status);
      
      -- Update visit: advance stage and mark as completed routing
      -- Setting routing_status to 'completed' means patient is auto-routed
      UPDATE visits
      SET 
        status = v_next_stage,
        routing_status = 'completed',
        updated_at = NOW()
      WHERE id = NEW.visit_id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on payments table
CREATE TRIGGER auto_update_visit_on_payment_complete
AFTER UPDATE OF payment_status ON public.payments
FOR EACH ROW
EXECUTE FUNCTION auto_update_visit_on_payment_complete();