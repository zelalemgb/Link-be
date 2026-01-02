-- Auto-update visit status when all items are paid
-- This trigger ensures visits transition out of 'paying_*' stages automatically

-- Function to check if all orders/items for a visit are paid
CREATE OR REPLACE FUNCTION check_visit_payment_complete(p_visit_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_unpaid BOOLEAN;
BEGIN
  -- Check if there are any unpaid items across all order types
  SELECT EXISTS (
    -- Check medication orders
    SELECT 1 FROM medication_orders 
    WHERE visit_id = p_visit_id 
      AND payment_status != 'paid'
      AND payment_status != 'waived'
    
    UNION ALL
    
    -- Check lab orders
    SELECT 1 FROM lab_orders 
    WHERE visit_id = p_visit_id 
      AND payment_status != 'paid'
      AND payment_status != 'waived'
    
    UNION ALL
    
    -- Check imaging orders
    SELECT 1 FROM imaging_orders 
    WHERE visit_id = p_visit_id 
      AND payment_status != 'paid'
      AND payment_status != 'waived'
    
    UNION ALL
    
    -- Check billing items (including consultation fees)
    SELECT 1 FROM billing_items 
    WHERE visit_id = p_visit_id 
      AND payment_status != 'paid'
      AND payment_status != 'waived'
  ) INTO v_has_unpaid;
  
  RETURN NOT v_has_unpaid;
END;
$$;

-- Function to determine next stage based on current status and orders
CREATE OR REPLACE FUNCTION determine_next_stage_after_payment(p_visit_id UUID, p_current_status TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_has_lab BOOLEAN;
  v_has_imaging BOOLEAN;
  v_has_medication BOOLEAN;
  v_next_stage TEXT;
BEGIN
  -- Check what orders exist
  SELECT 
    EXISTS(SELECT 1 FROM lab_orders WHERE visit_id = p_visit_id),
    EXISTS(SELECT 1 FROM imaging_orders WHERE visit_id = p_visit_id),
    EXISTS(SELECT 1 FROM medication_orders WHERE visit_id = p_visit_id)
  INTO v_has_lab, v_has_imaging, v_has_medication;
  
  -- Determine next stage based on current status
  IF p_current_status = 'paying_consultation' THEN
    -- After consultation payment, go to triage
    v_next_stage := 'at_triage';
  ELSIF p_current_status = 'paying_diagnosis' THEN
    -- After diagnosis payment, prioritize: lab > imaging > pharmacy
    IF v_has_lab THEN
      v_next_stage := 'at_lab';
    ELSIF v_has_imaging THEN
      v_next_stage := 'at_imaging';
    ELSIF v_has_medication THEN
      v_next_stage := 'at_pharmacy';
    ELSE
      v_next_stage := 'with_doctor'; -- Return to doctor if no orders
    END IF;
  ELSIF p_current_status = 'paying_pharmacy' THEN
    v_next_stage := 'at_pharmacy';
  ELSE
    -- Unknown paying state, default to with_doctor
    v_next_stage := 'with_doctor';
  END IF;
  
  RETURN v_next_stage;
END;
$$;

-- Trigger function to auto-update visit status after payment
CREATE OR REPLACE FUNCTION auto_update_visit_status_after_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_visit_status TEXT;
  v_is_fully_paid BOOLEAN;
  v_next_stage TEXT;
BEGIN
  -- Get current visit status
  SELECT status INTO v_visit_status
  FROM visits
  WHERE id = NEW.visit_id;
  
  -- Only proceed if visit is in a paying stage
  IF v_visit_status NOT IN ('paying_consultation', 'paying_diagnosis', 'paying_pharmacy') THEN
    RETURN NEW;
  END IF;
  
  -- Check if all items are now paid
  v_is_fully_paid := check_visit_payment_complete(NEW.visit_id);
  
  IF v_is_fully_paid THEN
    -- Determine next stage
    v_next_stage := determine_next_stage_after_payment(NEW.visit_id, v_visit_status);
    
    -- Update visit status and routing_status
    UPDATE visits
    SET 
      status = v_next_stage,
      routing_status = 'awaiting_routing',
      updated_at = NOW()
    WHERE id = NEW.visit_id;
    
    -- Log the transition
    RAISE NOTICE 'Auto-transitioned visit % from % to % after payment completion', 
      NEW.visit_id, v_visit_status, v_next_stage;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create triggers on all order and billing tables
DROP TRIGGER IF EXISTS auto_update_visit_on_medication_payment ON medication_orders;
CREATE TRIGGER auto_update_visit_on_medication_payment
AFTER UPDATE OF payment_status ON medication_orders
FOR EACH ROW
WHEN (NEW.payment_status IN ('paid', 'waived') AND OLD.payment_status != NEW.payment_status)
EXECUTE FUNCTION auto_update_visit_status_after_payment();

DROP TRIGGER IF EXISTS auto_update_visit_on_lab_payment ON lab_orders;
CREATE TRIGGER auto_update_visit_on_lab_payment
AFTER UPDATE OF payment_status ON lab_orders
FOR EACH ROW
WHEN (NEW.payment_status IN ('paid', 'waived') AND OLD.payment_status != NEW.payment_status)
EXECUTE FUNCTION auto_update_visit_status_after_payment();

DROP TRIGGER IF EXISTS auto_update_visit_on_imaging_payment ON imaging_orders;
CREATE TRIGGER auto_update_visit_on_imaging_payment
AFTER UPDATE OF payment_status ON imaging_orders
FOR EACH ROW
WHEN (NEW.payment_status IN ('paid', 'waived') AND OLD.payment_status != NEW.payment_status)
EXECUTE FUNCTION auto_update_visit_status_after_payment();

DROP TRIGGER IF EXISTS auto_update_visit_on_billing_payment ON billing_items;
CREATE TRIGGER auto_update_visit_on_billing_payment
AFTER UPDATE OF payment_status ON billing_items
FOR EACH ROW
WHEN (NEW.payment_status IN ('paid', 'waived') AND OLD.payment_status != NEW.payment_status)
EXECUTE FUNCTION auto_update_visit_status_after_payment();