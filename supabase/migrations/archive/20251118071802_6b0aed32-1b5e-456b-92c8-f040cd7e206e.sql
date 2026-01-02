-- Patch the overloaded register_patient_with_visit used by ReceptionIntakeForm
-- Fixes unit_price error by using medical_services.price (not unit_price),
-- adds case-insensitive category matching and price validation

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
  p_intake_patient_id text DEFAULT NULL::text,
  p_consultation_payment_type text DEFAULT 'paying'::text,
  p_program_id uuid DEFAULT NULL::uuid,
  p_creditor_id uuid DEFAULT NULL::uuid,
  p_insurer_id uuid DEFAULT NULL::uuid,
  p_insurance_policy_number text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patient_id uuid;
  v_visit_id uuid;
  v_full_name text;
  v_metadata jsonb;
  v_tenant_id uuid;
  v_consultation_service_id uuid;
  v_consultation_fee numeric(10,2);
  v_validation_result jsonb;
  v_warnings text[] := ARRAY[]::text[];
  v_valid_program_id uuid;
  v_valid_creditor_id uuid;
  v_valid_insurer_id uuid;
BEGIN
  -- Get tenant_id from user
  SELECT tenant_id INTO v_tenant_id
  FROM public.users
  WHERE id = p_user_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant ID not found for user';
  END IF;

  -- Build full name
  v_full_name := trim(coalesce(p_first_name,'') || ' ' || coalesce(p_middle_name,'') || ' ' || coalesce(p_last_name,''));

  -- Insert patient
  INSERT INTO public.patients (
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

  -- Validate payment master data and get sanitized IDs
  v_validation_result := public.validate_payment_master_data(
    v_tenant_id,
    p_program_id,
    p_creditor_id,
    p_insurer_id
  );

  v_valid_program_id := (v_validation_result->>'valid_program_id')::uuid;
  v_valid_creditor_id := (v_validation_result->>'valid_creditor_id')::uuid;
  v_valid_insurer_id := (v_validation_result->>'valid_insurer_id')::uuid;

  IF v_validation_result->>'program_warning' IS NOT NULL THEN
    v_warnings := array_append(v_warnings, v_validation_result->>'program_warning');
  END IF;
  IF v_validation_result->>'creditor_warning' IS NOT NULL THEN
    v_warnings := array_append(v_warnings, v_validation_result->>'creditor_warning');
  END IF;
  IF v_validation_result->>'insurer_warning' IS NOT NULL THEN
    v_warnings := array_append(v_warnings, v_validation_result->>'insurer_warning');
  END IF;

  -- Fetch consultation service using correct column names and case-insensitive category
  SELECT id, price INTO v_consultation_service_id, v_consultation_fee
  FROM public.medical_services
  WHERE facility_id = p_facility_id
    AND lower(category) = 'consultation'
    AND is_active = true
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_consultation_service_id IS NULL THEN
    RAISE EXCEPTION 'No consultation service configured for this facility. Please contact your facility administrator.';
  END IF;

  IF v_consultation_fee IS NULL THEN
    RAISE EXCEPTION 'Consultation service has no price configured (ID: %). Please contact your administrator.', v_consultation_service_id;
  END IF;

  IF v_consultation_fee <= 0 THEN
    RAISE EXCEPTION 'Consultation service has invalid price (%). Please contact your administrator.', v_consultation_fee;
  END IF;

  -- Build visit metadata
  v_metadata := jsonb_build_object(
    'visitType', p_visit_type,
    'residence', NULLIF(p_residence, ''),
    'occupation', NULLIF(p_occupation, ''),
    'intakeTimestamp', NULLIF(p_intake_timestamp, ''),
    'intakePatientId', NULLIF(p_intake_patient_id, ''),
    'formVersion', 'reception_intake_v1'
  );

  -- Insert visit (use legacy column names where applicable)
  INSERT INTO public.visits (
    tenant_id, patient_id, reason, provider, fee_paid, visit_date,
    created_by, facility_id, status, visit_notes,
    journey_timeline, status_updated_at,
    consultation_payment_type, insurance_provider_id, insurance_policy_number,
    program_id, creditor_id
  ) VALUES (
    v_tenant_id, v_patient_id, 'New Patient Registration', 'Reception Intake',
    CASE WHEN p_consultation_payment_type IN ('free','insurance') THEN v_consultation_fee ELSE 0 END,
    CURRENT_DATE,
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
    now(),
    p_consultation_payment_type,
    v_valid_insurer_id,
    NULLIF(p_insurance_policy_number, ''),
    v_valid_program_id,
    v_valid_creditor_id
  )
  RETURNING id INTO v_visit_id;

  -- Create billing item for consultation
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
    v_tenant_id,
    v_visit_id,
    v_consultation_service_id,
    v_patient_id,
    1,
    v_consultation_fee,
    v_consultation_fee,
    CASE WHEN p_consultation_payment_type IN ('free','insurance') THEN 'paid' ELSE 'unpaid' END,
    p_user_id
  );

  -- Return result
  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'visit_id', v_visit_id,
    'full_name', v_full_name,
    'warnings', CASE WHEN array_length(v_warnings,1) > 0 THEN v_warnings ELSE NULL END
  );
END;
$$;