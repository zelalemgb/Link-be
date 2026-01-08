-- ============================================================================
-- CONSOLIDATED MIGRATIONS FOR LINK APPLICATION
-- Apply this file in Supabase Dashboard SQL Editor
-- Project: qxihedrgltophafkuasa
-- Date: 2026-01-02
-- ============================================================================

-- ============================================================================
-- MIGRATION 1: Add Last Login Tracking for First-Time Onboarding
-- ============================================================================

-- Add last_login_at column to track user logins for first-time onboarding detection
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;

-- Backfill existing users to prevent showing onboarding to them
-- Set last_login_at to their created_at date for all existing users
UPDATE public.users 
SET last_login_at = created_at 
WHERE last_login_at IS NULL 
  AND created_at IS NOT NULL;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_users_last_login_at 
ON public.users(last_login_at);

-- Add comment for documentation
COMMENT ON COLUMN public.users.last_login_at IS 'Timestamp of the user''s most recent login. NULL indicates user has never logged in.';

-- ============================================================================
-- MIGRATION 2: Fix Patient Registration Function (Add Payment Parameters)
-- ============================================================================

-- Drop old function signature
DROP FUNCTION IF EXISTS public.register_patient_with_visit(
  text, text, text, text, integer, date, text, text, uuid, uuid,
  text, text, text, text, text, text, text, text, text, text
);

-- Create updated function with payment parameters
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
    p_program_id,
    p_creditor_id,
    p_insurer_id,
    p_insurance_policy_number
  )
  RETURNING id INTO v_visit_id;

  -- CRITICAL: Find and create consultation billing item
  -- First try: match visit type with service name
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

  -- Second try: any consultation service for this facility
  IF v_consultation_service_id IS NULL THEN
    SELECT id, COALESCE(price, 0) INTO v_consultation_service_id, v_consultation_price
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

-- ============================================================================
-- VERIFICATION QUERIES (Optional - Run these to verify migrations)
-- ============================================================================

-- Check if last_login_at column exists
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'users' AND column_name = 'last_login_at';

-- Check function signature
-- SELECT routine_name, routine_definition 
-- FROM information_schema.routines 
-- WHERE routine_name = 'register_patient_with_visit';
