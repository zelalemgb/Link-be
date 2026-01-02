-- Update register_patient_with_visit function to accept payment type parameters
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
  -- NEW PARAMETERS
  p_consultation_payment_type text DEFAULT 'paying',
  p_insurance_provider text DEFAULT NULL,
  p_insurance_policy_number text DEFAULT NULL
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
  v_metadata jsonb;
  v_tenant_id uuid;
  v_normalized_fayida_id text;
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

  -- Insert visit with NEW payment type fields
  INSERT INTO visits (
    tenant_id, patient_id, reason, provider, fee_paid, visit_date,
    created_by, facility_id, status, visit_notes,
    journey_timeline, status_updated_at,
    consultation_payment_type, insurance_provider, insurance_policy_number
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
    NULLIF(p_insurance_provider, ''),
    NULLIF(p_insurance_policy_number, '')
  )
  RETURNING id INTO v_visit_id;

  -- Return result
  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'visit_id', v_visit_id,
    'full_name', v_full_name
  );
END;
$function$;