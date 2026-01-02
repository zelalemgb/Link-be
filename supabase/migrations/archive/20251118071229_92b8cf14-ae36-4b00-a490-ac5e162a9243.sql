-- Fix schema mismatch in register_patient_with_visit function
-- Update to use correct column names: category (not service_category) and price (not unit_price)

DROP FUNCTION IF EXISTS public.register_patient_with_visit(
  p_full_name TEXT,
  p_date_of_birth DATE,
  p_gender TEXT,
  p_phone_number TEXT,
  p_national_id TEXT,
  p_emergency_contact_name TEXT,
  p_emergency_contact_phone TEXT,
  p_facility_id UUID,
  p_visit_type TEXT,
  p_payment_type TEXT,
  p_program_id UUID,
  p_creditor_id UUID,
  p_insurer_id UUID,
  p_insurance_number TEXT,
  p_region TEXT,
  p_woreda TEXT,
  p_kebele TEXT,
  p_ketena_gott TEXT
);

CREATE OR REPLACE FUNCTION public.register_patient_with_visit(
  p_full_name TEXT,
  p_date_of_birth DATE,
  p_gender TEXT,
  p_phone_number TEXT,
  p_national_id TEXT,
  p_emergency_contact_name TEXT,
  p_emergency_contact_phone TEXT,
  p_facility_id UUID,
  p_visit_type TEXT,
  p_payment_type TEXT,
  p_program_id UUID DEFAULT NULL,
  p_creditor_id UUID DEFAULT NULL,
  p_insurer_id UUID DEFAULT NULL,
  p_insurance_number TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_woreda TEXT DEFAULT NULL,
  p_kebele TEXT DEFAULT NULL,
  p_ketena_gott TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tenant_id UUID;
  v_patient_id UUID;
  v_visit_id UUID;
  v_consultation_service_id UUID;
  v_consultation_fee NUMERIC(10,2);
  v_created_by UUID;
  v_validation_result JSONB;
  v_warnings TEXT[] := ARRAY[]::TEXT[];
  v_valid_program_id UUID;
  v_valid_creditor_id UUID;
  v_valid_insurer_id UUID;
BEGIN
  -- Get tenant_id from facility
  SELECT tenant_id INTO v_tenant_id
  FROM facilities
  WHERE id = p_facility_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Facility not found or has no tenant association';
  END IF;

  -- Get the authenticated user ID
  v_created_by := auth.uid();
  IF v_created_by IS NULL THEN
    RAISE EXCEPTION 'User must be authenticated to register patients';
  END IF;

  -- Validate payment master data and get sanitized IDs
  v_validation_result := validate_payment_master_data(
    v_tenant_id,
    p_program_id,
    p_creditor_id,
    p_insurer_id
  );

  -- Extract validated IDs
  v_valid_program_id := (v_validation_result->>'valid_program_id')::UUID;
  v_valid_creditor_id := (v_validation_result->>'valid_creditor_id')::UUID;
  v_valid_insurer_id := (v_validation_result->>'valid_insurer_id')::UUID;

  -- Collect warnings
  IF v_validation_result->>'program_warning' IS NOT NULL THEN
    v_warnings := array_append(v_warnings, v_validation_result->>'program_warning');
  END IF;
  IF v_validation_result->>'creditor_warning' IS NOT NULL THEN
    v_warnings := array_append(v_warnings, v_validation_result->>'creditor_warning');
  END IF;
  IF v_validation_result->>'insurer_warning' IS NOT NULL THEN
    v_warnings := array_append(v_warnings, v_validation_result->>'insurer_warning');
  END IF;

  -- Insert patient record
  INSERT INTO patients (
    tenant_id,
    facility_id,
    full_name,
    date_of_birth,
    gender,
    phone_number,
    national_id,
    emergency_contact_name,
    emergency_contact_phone,
    region,
    woreda,
    kebele,
    ketena_gott
  ) VALUES (
    v_tenant_id,
    p_facility_id,
    p_full_name,
    p_date_of_birth,
    p_gender,
    p_phone_number,
    p_national_id,
    p_emergency_contact_name,
    p_emergency_contact_phone,
    p_region,
    p_woreda,
    p_kebele,
    p_ketena_gott
  ) RETURNING id INTO v_patient_id;

  -- Fetch consultation service using correct column names
  SELECT id, price INTO v_consultation_service_id, v_consultation_fee
  FROM medical_services
  WHERE facility_id = p_facility_id
    AND LOWER(category) = 'consultation'
    AND is_active = true
  LIMIT 1;

  -- Validate consultation service exists
  IF v_consultation_service_id IS NULL THEN
    RAISE EXCEPTION 'No consultation service configured for this facility. Please contact your facility administrator.';
  END IF;

  -- Validate consultation fee is not NULL
  IF v_consultation_fee IS NULL THEN
    RAISE EXCEPTION 'Consultation service has no price configured (ID: %). Please contact your administrator.', v_consultation_service_id;
  END IF;

  -- Validate consultation fee is positive
  IF v_consultation_fee <= 0 THEN
    RAISE EXCEPTION 'Consultation service has invalid price (%). Please contact your administrator.', v_consultation_fee;
  END IF;

  -- Insert visit record with validated payment master data IDs
  INSERT INTO visits (
    tenant_id,
    facility_id,
    patient_id,
    visit_type,
    payment_type,
    program_id,
    creditor_id,
    insurer_id,
    insurance_number,
    fee_amount,
    fee_paid
  ) VALUES (
    v_tenant_id,
    p_facility_id,
    v_patient_id,
    p_visit_type,
    p_payment_type,
    v_valid_program_id,
    v_valid_creditor_id,
    v_valid_insurer_id,
    p_insurance_number,
    v_consultation_fee,
    CASE 
      WHEN p_payment_type IN ('free', 'insurance') THEN true
      ELSE false
    END
  ) RETURNING id INTO v_visit_id;

  -- Insert consultation billing item
  INSERT INTO billing_items (
    tenant_id,
    visit_id,
    patient_id,
    service_id,
    unit_price,
    quantity,
    total_amount,
    payment_status,
    created_by
  ) VALUES (
    v_tenant_id,
    v_visit_id,
    v_patient_id,
    v_consultation_service_id,
    v_consultation_fee,
    1,
    v_consultation_fee,
    CASE 
      WHEN p_payment_type IN ('free', 'insurance') THEN 'paid'
      ELSE 'unpaid'
    END,
    v_created_by
  );

  -- Return result with warnings
  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'visit_id', v_visit_id,
    'full_name', p_full_name,
    'warnings', CASE WHEN array_length(v_warnings, 1) > 0 THEN v_warnings ELSE NULL END
  );
END;
$$;