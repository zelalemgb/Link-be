-- Migration: Kill Phantom Dressing Bug Final
-- Description: 
-- 1. Updates "Dressing" services to correctly be "Procedure" category.
-- 2. Removes dangerous "Fallback 2" from register_patient_with_visit which was picking random services.
-- 3. Drops legacy auto-fee triggers just in case.

-- 1. DATA FIX: Ensure no Dressing is a Consultation
UPDATE public.medical_services
SET category = 'Procedure'
WHERE name ILIKE '%Dressing%' AND category = 'Consultation';

-- 2. TRIGGER KILL: Explicitly drop potential legacy triggers
DROP TRIGGER IF EXISTS trigger_auto_add_consultation_fee ON public.visits;
DROP FUNCTION IF EXISTS public.auto_add_consultation_fee();

-- 3. LOGIC FIX: Update RPC to remove dangerous fallback
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
  p_insurance_policy_number text DEFAULT NULL::text,
  p_consultation_service_id uuid DEFAULT NULL::uuid,
  p_provider text DEFAULT 'Reception Intake'::text
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

  -- Insert patient with tenant_id
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

  -- Persist identifier separately for downstream systems
  IF v_normalized_fayida_id IS NOT NULL THEN
    INSERT INTO patient_identifiers (
      patient_id,
      tenant_id,
      identifier_type,
      identifier_value,
      is_primary
    ) VALUES (
      v_patient_id,
      v_tenant_id,
      'fayida_id',
      v_normalized_fayida_id,
      true
    );
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

  -- Insert visit with initial journey tracking and tenant_id
  INSERT INTO visits (
    tenant_id, patient_id, reason, provider, fee_paid, visit_date,
    created_by, facility_id, status, visit_notes,
    journey_timeline, status_updated_at,
    consultation_payment_type, program_id, creditor_id,
    insurance_provider_id, insurance_policy_number
  ) VALUES (
    v_tenant_id, v_patient_id, 'New Patient Registration', p_provider, 0, CURRENT_DATE,
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
    p_program_id,
    p_creditor_id,
    p_insurer_id,
    p_insurance_policy_number
  )
  RETURNING id INTO v_visit_id;

  -- CRITICAL: Find and create consultation billing item
  
  -- NEW LOGIC: Use provided service ID if available
  IF p_consultation_service_id IS NOT NULL THEN
    SELECT id, COALESCE(price, 0) INTO v_consultation_service_id, v_consultation_price
    FROM medical_services
    WHERE id = p_consultation_service_id
      AND facility_id = p_facility_id
      AND is_active = true;
  END IF;

  -- Fallback 1: match visit type with service name (Legacy Logic)
  IF v_consultation_service_id IS NULL THEN
    SELECT id, COALESCE(price, 0) INTO v_consultation_service_id, v_consultation_price
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
  END IF;

  -- REMOVED: Fallback 2 (Any random consultation service) - This was causing 'Dressing' to be picked up if misconfigured.

  -- BLOCK REGISTRATION if no consultation service configured
  IF v_consultation_service_id IS NULL THEN
    -- Provide a clearer error message
    RAISE EXCEPTION 'No matching consultation service found (e.g. New Patient Consultation). Please check your Services Directory.';
  END IF;

  -- Create billing item (now guaranteed to have service)
  INSERT INTO billing_items (
    tenant_id, visit_id, patient_id, service_id, quantity,
    unit_price, total_amount, created_by, payment_status
  ) VALUES (
    v_tenant_id, v_visit_id, v_patient_id, v_consultation_service_id, 1,
    v_consultation_price, v_consultation_price, p_user_id, 'unpaid'
  )
  ON CONFLICT ON CONSTRAINT unique_visit_service DO NOTHING;

  -- Return patient and visit IDs
  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'visit_id', v_visit_id,
    'full_name', v_full_name
  );
END;
$function$;
