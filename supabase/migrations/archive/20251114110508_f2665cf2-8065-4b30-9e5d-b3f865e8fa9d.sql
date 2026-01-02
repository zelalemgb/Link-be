
-- First, delete duplicate billing items, keeping only the first one for each visit+service combination
DELETE FROM public.billing_items
WHERE id IN (
  SELECT id
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY visit_id, service_id ORDER BY created_at) AS rn
    FROM public.billing_items
  ) t
  WHERE t.rn > 1
);

-- Now add the unique constraint to prevent future duplicates
ALTER TABLE public.billing_items 
ADD CONSTRAINT unique_visit_service 
UNIQUE (visit_id, service_id);

-- Update the auto_add_consultation_fee function to handle constraint violations gracefully
CREATE OR REPLACE FUNCTION public.auto_add_consultation_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_facility_id uuid;
  v_last_visit_date date;
  v_consultation_service record;
  v_fee_to_charge numeric;
  v_follow_up_days integer;
  v_service_id uuid;
  v_exists boolean;
BEGIN
  -- Get facility_id from the visit
  v_facility_id := NEW.facility_id;
  
  -- Find the consultation service for this facility
  SELECT id, price, follow_up_price, COALESCE(follow_up_days, 10) as follow_up_days
  INTO v_consultation_service
  FROM public.medical_services
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
  v_service_id := v_consultation_service.id;
  
  -- Skip if a consultation billing item already exists for this visit
  -- This check is now backed by a unique constraint
  SELECT EXISTS (
    SELECT 1 FROM public.billing_items
    WHERE visit_id = NEW.id
      AND service_id = v_service_id
  ) INTO v_exists;
  
  IF v_exists THEN
    RETURN NEW;
  END IF;
  
  -- Check for previous visits by this patient at this facility
  SELECT visit_date INTO v_last_visit_date
  FROM public.visits
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
  -- The unique constraint will prevent duplicates even if this somehow runs twice
  BEGIN
    INSERT INTO public.billing_items (
      tenant_id,
      visit_id,
      service_id,
      patient_id,
      quantity,
      unit_price,
      total_amount,
      payment_status,
      created_by
    ) VALUES (
      NEW.tenant_id,
      NEW.id,
      v_service_id,
      NEW.patient_id,
      1,
      v_fee_to_charge,
      v_fee_to_charge,
      'unpaid',
      NEW.created_by
    );
  EXCEPTION
    WHEN unique_violation THEN
      -- Silently ignore if duplicate, constraint prevents it
      NULL;
  END;
  
  RETURN NEW;
END;
$$;
