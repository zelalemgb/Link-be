-- =====================================================
-- PHASE 1: Performance Indexes for Patient Registration
-- =====================================================

-- Speed up queue filtering by facility and creation date
CREATE INDEX IF NOT EXISTS idx_patients_facility_created 
ON patients(facility_id, created_at DESC);

-- Speed up visit status lookups
CREATE INDEX IF NOT EXISTS idx_visits_patient_status 
ON visits(patient_id, status) INCLUDE (visit_date);

-- Speed up service lookups during registration
CREATE INDEX IF NOT EXISTS idx_medical_services_lookup 
ON medical_services(facility_id, category, is_active) 
WHERE is_active = true;

-- Speed up payment status checks
CREATE INDEX IF NOT EXISTS idx_billing_payment_status 
ON billing_items(visit_id, payment_status);

-- Speed up user facility lookups
CREATE INDEX IF NOT EXISTS idx_users_auth_facility 
ON users(auth_user_id) INCLUDE (id, facility_id);

-- Speed up facility admin lookups
CREATE INDEX IF NOT EXISTS idx_facilities_admin 
ON facilities(admin_user_id) INCLUDE (id);

-- =====================================================
-- PHASE 2: Optimized Journey Tracking Function
-- =====================================================

CREATE OR REPLACE FUNCTION append_journey_stage(
  p_visit_id uuid,
  p_stage text,
  p_user_id uuid DEFAULT NULL
) RETURNS void 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update visit with new journey stage using jsonb operators
  -- Only append if stage doesn't already exist
  UPDATE visits
  SET 
    journey_timeline = COALESCE(journey_timeline, '{}'::jsonb) || 
      jsonb_build_object(
        'stages', 
        COALESCE(journey_timeline->'stages', '[]'::jsonb) || 
        jsonb_build_array(jsonb_build_object(
          'stage', p_stage,
          'timestamp', now(),
          'completedBy', p_user_id
        ))
      ),
    status = p_stage,
    status_updated_at = now()
  WHERE id = p_visit_id
    -- Check if stage doesn't already exist
    AND NOT EXISTS (
      SELECT 1 
      FROM jsonb_array_elements(COALESCE(journey_timeline->'stages', '[]'::jsonb)) AS stage
      WHERE stage->>'stage' = p_stage
    );
END;
$$;

-- =====================================================
-- PHASE 3: Single Transaction Registration Function
-- =====================================================

CREATE OR REPLACE FUNCTION register_patient_with_visit(
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
  p_intake_patient_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patient_id uuid;
  v_visit_id uuid;
  v_full_name text;
  v_consultation_service_id uuid;
  v_consultation_price numeric;
  v_metadata jsonb;
BEGIN
  -- Build full name
  v_full_name := p_first_name || ' ' || p_middle_name || ' ' || p_last_name;
  
  -- Insert patient
  INSERT INTO patients (
    first_name, middle_name, last_name, full_name,
    gender, age, date_of_birth, phone, fayida_id,
    created_by, facility_id,
    region, woreda_subcity, ketena_gott, kebele, house_number
  ) VALUES (
    p_first_name, p_middle_name, p_last_name, v_full_name,
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
  
  -- Insert visit with initial journey tracking
  INSERT INTO visits (
    patient_id, reason, provider, fee_paid, visit_date,
    created_by, facility_id, status, visit_notes,
    journey_timeline, status_updated_at
  ) VALUES (
    v_patient_id, 'New Patient Registration', 'Reception Intake', 0, CURRENT_DATE,
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
  
  -- Try to find and create consultation billing item
  BEGIN
    -- Determine search keyword based on visit type
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
    
    -- Fallback: try any consultation service
    IF v_consultation_service_id IS NULL THEN
      SELECT id, price INTO v_consultation_service_id, v_consultation_price
      FROM medical_services
      WHERE category = 'Consultation'
        AND is_active = true
        AND (
          (p_visit_type = 'New' AND name ILIKE '%new patient%') OR
          (p_visit_type = 'Follow-up' AND name ILIKE '%follow-up%') OR
          (p_visit_type = 'Returning' AND name ILIKE '%returning patient%')
        )
      LIMIT 1;
    END IF;
    
    -- Create billing item if service found
    IF v_consultation_service_id IS NOT NULL THEN
      INSERT INTO billing_items (
        visit_id, patient_id, service_id, quantity,
        unit_price, total_amount, created_by, payment_status
      ) VALUES (
        v_visit_id, v_patient_id, v_consultation_service_id, 1,
        v_consultation_price, v_consultation_price, p_user_id, 'unpaid'
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      -- Billing item creation is non-critical, continue
      NULL;
  END;
  
  -- Return patient and visit IDs
  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'visit_id', v_visit_id,
    'full_name', v_full_name
  );
END;
$$;