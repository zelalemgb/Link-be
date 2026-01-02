-- Fix duplicate billing item issue by removing redundant logic from RPC
-- First drop the existing function, then recreate with correct parameters

DROP FUNCTION IF EXISTS public.register_patient_with_visit(
  text, text, text, text, integer, date, text, text, uuid, uuid,
  text, text, text, text, text, text, text, text, text, text,
  text, uuid, uuid, uuid, text
);

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
  p_region text DEFAULT NULL,
  p_woreda_subcity text DEFAULT NULL,
  p_ketena_gott text DEFAULT NULL,
  p_kebele text DEFAULT NULL,
  p_house_number text DEFAULT NULL,
  p_visit_type text DEFAULT 'New',
  p_residence text DEFAULT NULL,
  p_occupation text DEFAULT NULL,
  p_intake_timestamp text DEFAULT NULL,
  p_intake_patient_id text DEFAULT NULL,
  p_consultation_payment_type text DEFAULT 'paying',
  p_program_id uuid DEFAULT NULL,
  p_creditor_id uuid DEFAULT NULL,
  p_insurer_id uuid DEFAULT NULL,
  p_insurance_policy_number text DEFAULT NULL
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
  v_normalized_fayida_id text;
  v_consultation_service_id uuid;
  v_consultation_fee numeric;
  v_payment_validation jsonb;
  v_valid_program_id uuid;
  v_valid_creditor_id uuid;
  v_valid_insurer_id uuid;
  v_warnings text[] := ARRAY[]::text[];
BEGIN
  -- Get tenant_id from facility
  SELECT tenant_id INTO v_tenant_id
  FROM public.facilities
  WHERE id = p_facility_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Facility not found or has no tenant association';
  END IF;

  -- Validate payment master data
  SELECT public.validate_payment_master_data(
    v_tenant_id,
    p_program_id,
    p_creditor_id,
    p_insurer_id
  ) INTO v_payment_validation;

  v_valid_program_id := (v_payment_validation->>'program_id')::uuid;
  v_valid_creditor_id := (v_payment_validation->>'creditor_id')::uuid;
  v_valid_insurer_id := (v_payment_validation->>'insurer_id')::uuid;

  -- Collect warnings
  IF (v_payment_validation->'warnings') IS NOT NULL THEN
    v_warnings := ARRAY(SELECT jsonb_array_elements_text(v_payment_validation->'warnings'));
  END IF;

  -- Build full name
  v_full_name := p_first_name || ' ' || p_middle_name || ' ' || p_last_name;

  -- Normalize Fayida ID
  v_normalized_fayida_id := NULLIF(p_fayida_id, '');
  IF v_normalized_fayida_id IS NOT NULL THEN
    v_normalized_fayida_id := regexp_replace(v_normalized_fayida_id, '[^0-9]', '', 'g');
    IF length(v_normalized_fayida_id) <> 16 THEN
      RAISE EXCEPTION 'National ID must be 16 digits';
    END IF;
    v_normalized_fayida_id :=
      substr(v_normalized_fayida_id, 1, 4) || '-' ||
      substr(v_normalized_fayida_id, 5, 4) || '-' ||
      substr(v_normalized_fayida_id, 9, 4) || '-' ||
      substr(v_normalized_fayida_id, 13, 4);
  END IF;

  -- Verify consultation service exists and has valid price
  SELECT id, price INTO v_consultation_service_id, v_consultation_fee
  FROM public.medical_services
  WHERE facility_id = p_facility_id
    AND LOWER(category) = 'consultation'
    AND is_active = true
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_consultation_service_id IS NULL THEN
    RAISE EXCEPTION 'No consultation service configured for this facility. Please contact your administrator to configure consultation services.';
  END IF;

  IF v_consultation_fee IS NULL OR v_consultation_fee <= 0 THEN
    RAISE EXCEPTION 'Consultation service has no price configured or invalid price. Please contact your administrator.';
  END IF;

  -- Insert patient
  INSERT INTO patients (
    tenant_id, first_name, middle_name, last_name, full_name,
    gender, age, date_of_birth, phone, fayida_id,
    created_by, facility_id,
    region, woreda_subcity, ketena_gott, kebele, house_number
  ) VALUES (
    v_tenant_id, p_first_name, p_middle_name, p_last_name, v_full_name,
    p_gender, p_age, p_date_of_birth, p_phone, v_normalized_fayida_id,
    p_user_id, p_facility_id,
    NULLIF(p_region, ''), NULLIF(p_woreda_subcity, ''),
    NULLIF(p_ketena_gott, ''), NULLIF(p_kebele, ''), NULLIF(p_house_number, '')
  )
  RETURNING id INTO v_patient_id;

  -- Persist identifier if provided
  IF v_normalized_fayida_id IS NOT NULL THEN
    INSERT INTO patient_identifiers (
      patient_id, tenant_id, identifier_type, identifier_value, is_primary
    ) VALUES (
      v_patient_id, v_tenant_id, 'fayida_id', v_normalized_fayida_id, true
    );
  END IF;

  -- Build metadata
  v_metadata := jsonb_build_object(
    'visitType', p_visit_type,
    'residence', NULLIF(p_residence, ''),
    'occupation', NULLIF(p_occupation, ''),
    'intakeTimestamp', NULLIF(p_intake_timestamp, ''),
    'intakePatientId', NULLIF(p_intake_patient_id, ''),
    'formVersion', 'reception_intake_v1'
  );

  -- Insert visit with payment details
  INSERT INTO visits (
    tenant_id, patient_id, reason, provider, fee_paid, visit_date,
    created_by, facility_id, status, visit_notes,
    journey_timeline, status_updated_at,
    consultation_payment_type, program_id, creditor_id, insurer_id, insurance_policy_number
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
    now(),
    p_consultation_payment_type,
    v_valid_program_id, v_valid_creditor_id, v_valid_insurer_id, NULLIF(p_insurance_policy_number, '')
  )
  RETURNING id INTO v_visit_id;

  -- NOTE: Consultation billing item is automatically created by the auto_add_consultation_fee trigger
  -- This trigger handles follow-up vs new patient pricing logic and prevents duplicates

  -- Return result with warnings
  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'visit_id', v_visit_id,
    'full_name', v_full_name,
    'warnings', CASE WHEN array_length(v_warnings, 1) > 0 THEN array_to_json(v_warnings) ELSE NULL END
  );
END;
$$;