-- Fix register_patient_with_visit to require consultation service configuration
CREATE OR REPLACE FUNCTION public.register_patient_with_visit(
  p_first_name text, 
  p_middle_name text, 
  p_last_name text, 
  p_gender text, 
  p_age integer, 
  p_date_of_birth date, 
  p_phone text, 
  p_fayida_id text, 
  p_user_id uuid, 
  p_facility_id uuid, 
  p_region text DEFAULT NULL::text, 
  p_woreda_subcity text DEFAULT NULL::text, 
  p_ketena_gott text DEFAULT NULL::text, 
  p_kebele text DEFAULT NULL::text, 
  p_house_number text DEFAULT NULL::text, 
  p_visit_type text DEFAULT 'New'::text, 
  p_residence text DEFAULT NULL::text, 
  p_occupation text DEFAULT NULL::text, 
  p_intake_timestamp text DEFAULT NULL::text, 
  p_intake_patient_id text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_patient_id uuid;
  v_visit_id uuid;
  v_full_name text;
  v_consultation_service_id uuid;
  v_consultation_price numeric;
  v_metadata jsonb;
  v_tenant_id uuid;
BEGIN
  -- Get tenant_id from user
  SELECT tenant_id INTO v_tenant_id
  FROM public.users
  WHERE id = p_user_id;
  
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant ID not found for user';
  END IF;
  
  -- Build full name
  v_full_name := p_first_name || ' ' || p_middle_name || ' ' || p_last_name;
  
  -- Insert patient with tenant_id
  INSERT INTO patients (
    tenant_id, first_name, middle_name, last_name, full_name,
    gender, age, date_of_birth, phone, fayida_id,
    created_by, facility_id,
    region, woreda_subcity, ketena_gott, kebele, house_number
  ) VALUES (
    v_tenant_id, p_first_name, p_middle_name, p_last_name, v_full_name,
    p_gender, p_age, p_date_of_birth, p_phone, NULLIF(p_fayida_id, ''),
    p_user_id, p_facility_id,
    NULLIF(p_region, ''), NULLIF(p_woreda_subcity, ''), 
    NULLIF(p_ketena_gott, ''), NULLIF(p_kebele, ''), NULLIF(p_house_number, '')
  )
  RETURNING id INTO v_patient_id;
  
  -- Build visit metadata
  v_metadata := jsonb_build_object(
    'visitType', p_visit_type,
    'residence', NULLIF(p_residence, ''),
    'occupation', NULLIF(p_occupation, ''),
    'intakeTimestamp', NULLIF(p_intake_timestamp, ''),
    'intakePatientId', NULLIF(p_intake_patient_id, ''),
    'formVersion', 'reception_intake_v1'
  );
  
  -- Insert visit with initial journey tracking and tenant_id
  INSERT INTO visits (
    tenant_id, patient_id, reason, provider, fee_paid, visit_date,
    created_by, facility_id, status, visit_notes,
    journey_timeline, status_updated_at
  ) VALUES (
    v_tenant_id, v_patient_id, 'New Patient Registration', 'Reception Intake', 0, CURRENT_DATE,
    p_user_id, p_facility_id, 'registered', v_metadata::text,
    jsonb_build_object(
      'stages', jsonb_build_array(
        jsonb_build_object(
          'stage', 'registered',
          'timestamp', now(),
          'completedBy', p_user_id
        )
      )
    ),
    now()
  )
  RETURNING id INTO v_visit_id;
  
  -- CRITICAL: Find and create consultation billing item
  -- First try: match visit type with service name
  SELECT id, price INTO v_consultation_service_id, v_consultation_price
  FROM medical_services
  WHERE facility_id = p_facility_id
    AND category = 'Consultation'
    AND is_active = true
    AND (
      (p_visit_type = 'New' AND name ILIKE '%new patient%') OR
      (p_visit_type = 'Follow-up' AND name ILIKE '%follow-up%') OR
      (p_visit_type = 'Returning' AND name ILIKE '%returning patient%')
    )
  LIMIT 1;
  
  -- Second try: any consultation service for this facility
  IF v_consultation_service_id IS NULL THEN
    SELECT id, price INTO v_consultation_service_id, v_consultation_price
    FROM medical_services
    WHERE facility_id = p_facility_id
      AND category = 'Consultation'
      AND is_active = true
    LIMIT 1;
  END IF;
  
  -- BLOCK REGISTRATION if no consultation service configured
  IF v_consultation_service_id IS NULL THEN
    RAISE EXCEPTION 'No consultation service configured for this facility. Please configure consultation services in Services Directory before registering patients.';
  END IF;
  
  -- Create billing item (now guaranteed to have service)
  INSERT INTO billing_items (
    tenant_id, visit_id, patient_id, service_id, quantity,
    unit_price, total_amount, created_by, payment_status
  ) VALUES (
    v_tenant_id, v_visit_id, v_patient_id, v_consultation_service_id, 1,
    v_consultation_price, v_consultation_price, p_user_id, 'unpaid'
  );
  
  -- Return patient and visit IDs
  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'visit_id', v_visit_id,
    'full_name', v_full_name
  );
END;
$function$;