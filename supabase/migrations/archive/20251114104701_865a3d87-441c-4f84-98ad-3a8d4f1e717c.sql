-- Fix security warning by setting search_path for the function
CREATE OR REPLACE FUNCTION auto_add_consultation_fee()
RETURNS TRIGGER AS $$
DECLARE
  v_facility_id uuid;
  v_last_visit_date date;
  v_consultation_service record;
  v_fee_to_charge numeric;
  v_follow_up_days integer;
BEGIN
  -- Get facility_id from the visit
  v_facility_id := NEW.facility_id;
  
  -- Find the consultation service for this facility
  SELECT id, price, follow_up_price, COALESCE(follow_up_days, 10) as follow_up_days
  INTO v_consultation_service
  FROM medical_services
  WHERE facility_id = v_facility_id
    AND category = 'Consultation'
    AND is_active = true
  ORDER BY created_at DESC
  LIMIT 1;
  
  -- If no consultation service found, exit
  IF v_consultation_service IS NULL THEN
    RETURN NEW;
  END IF;
  
  v_follow_up_days := v_consultation_service.follow_up_days;
  
  -- Check for previous visits by this patient at this facility
  SELECT visit_date INTO v_last_visit_date
  FROM visits
  WHERE patient_id = NEW.patient_id
    AND facility_id = v_facility_id
    AND id != NEW.id
    AND visit_date IS NOT NULL
  ORDER BY visit_date DESC
  LIMIT 1;
  
  -- Determine which fee to charge
  IF v_last_visit_date IS NOT NULL AND 
     (NEW.visit_date - v_last_visit_date) <= v_follow_up_days THEN
    -- Within follow-up period, use follow-up price if available
    v_fee_to_charge := COALESCE(v_consultation_service.follow_up_price, v_consultation_service.price);
  ELSE
    -- New patient or outside follow-up period, use regular price
    v_fee_to_charge := v_consultation_service.price;
  END IF;
  
  -- Create billing item for consultation
  INSERT INTO billing_items (
    tenant_id,
    facility_id,
    visit_id,
    patient_id,
    service_name,
    category,
    quantity,
    unit_price,
    amount,
    payment_status,
    created_by
  ) VALUES (
    NEW.tenant_id,
    v_facility_id,
    NEW.id,
    NEW.patient_id,
    'Consultation',
    'Consultation',
    1,
    v_fee_to_charge,
    v_fee_to_charge,
    'unpaid',
    NEW.created_by
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;