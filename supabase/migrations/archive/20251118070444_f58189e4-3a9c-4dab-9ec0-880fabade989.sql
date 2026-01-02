-- Phase 1: Update visits table FK constraint to use insurers table
-- Drop old FK constraint if exists
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'visits_insurance_provider_id_fkey'
  ) THEN
    ALTER TABLE visits DROP CONSTRAINT visits_insurance_provider_id_fkey;
  END IF;
END $$;

-- Add new FK constraint pointing to insurers table
ALTER TABLE visits 
  ADD CONSTRAINT visits_insurer_id_fkey 
  FOREIGN KEY (insurance_provider_id) 
  REFERENCES insurers(id);

-- Create validation function for payment master data
CREATE OR REPLACE FUNCTION validate_payment_master_data(
  p_program_id uuid,
  p_creditor_id uuid,
  p_insurer_id uuid,
  p_tenant_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_result jsonb := '{"valid": true, "warnings": []}'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  -- Validate program_id if provided
  IF p_program_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM programs 
      WHERE id = p_program_id 
      AND tenant_id = p_tenant_id 
      AND is_active = true
    ) THEN
      v_warnings := v_warnings || jsonb_build_object(
        'field', 'program_id',
        'message', 'Invalid or inactive program selected'
      );
    END IF;
  END IF;

  -- Validate creditor_id if provided
  IF p_creditor_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM creditors 
      WHERE id = p_creditor_id 
      AND tenant_id = p_tenant_id 
      AND is_active = true
    ) THEN
      v_warnings := v_warnings || jsonb_build_object(
        'field', 'creditor_id',
        'message', 'Invalid or inactive creditor selected'
      );
    END IF;
  END IF;

  -- Validate insurer_id if provided
  IF p_insurer_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM insurers 
      WHERE id = p_insurer_id 
      AND tenant_id = p_tenant_id 
      AND is_active = true
    ) THEN
      v_warnings := v_warnings || jsonb_build_object(
        'field', 'insurer_id',
        'message', 'Invalid or inactive insurer selected'
      );
    END IF;
  END IF;

  -- Build result
  IF jsonb_array_length(v_warnings) > 0 THEN
    v_result := jsonb_build_object(
      'valid', false,
      'warnings', v_warnings
    );
  END IF;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop old register_patient_with_visit function with old parameter signature
DROP FUNCTION IF EXISTS register_patient_with_visit(
  text, text, text, text, integer, date, text, text, uuid, uuid,
  text, text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, text
);

-- Create new register_patient_with_visit with p_insurer_id parameter
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
  p_intake_patient_id text DEFAULT NULL,
  p_consultation_payment_type text DEFAULT 'paying',
  p_program_id uuid DEFAULT NULL,
  p_creditor_id uuid DEFAULT NULL,
  p_insurer_id uuid DEFAULT NULL,
  p_insurance_policy_number text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_patient_id uuid;
  v_visit_id uuid;
  v_tenant_id uuid;
  v_full_name text;
  v_consultation_service_id uuid;
  v_consultation_fee numeric := 0;
  v_validation_result jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_final_program_id uuid := p_program_id;
  v_final_creditor_id uuid := p_creditor_id;
  v_final_insurer_id uuid := p_insurer_id;
BEGIN
  -- Get tenant_id from facility
  SELECT tenant_id INTO v_tenant_id
  FROM facilities
  WHERE id = p_facility_id;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Facility not found or has no tenant';
  END IF;

  -- Validate payment master data and clear invalid FKs
  v_validation_result := validate_payment_master_data(
    p_program_id, 
    p_creditor_id, 
    p_insurer_id, 
    v_tenant_id
  );

  -- If validation failed, clear invalid FKs and collect warnings
  IF (v_validation_result->>'valid')::boolean = false THEN
    v_warnings := v_validation_result->'warnings';
    
    -- Clear invalid program_id
    IF p_program_id IS NOT NULL AND 
       EXISTS (SELECT 1 FROM jsonb_array_elements(v_warnings) 
               WHERE value->>'field' = 'program_id') THEN
      v_final_program_id := NULL;
    END IF;
    
    -- Clear invalid creditor_id
    IF p_creditor_id IS NOT NULL AND 
       EXISTS (SELECT 1 FROM jsonb_array_elements(v_warnings) 
               WHERE value->>'field' = 'creditor_id') THEN
      v_final_creditor_id := NULL;
    END IF;
    
    -- Clear invalid insurer_id
    IF p_insurer_id IS NOT NULL AND 
       EXISTS (SELECT 1 FROM jsonb_array_elements(v_warnings) 
               WHERE value->>'field' = 'insurer_id') THEN
      v_final_insurer_id := NULL;
    END IF;
  END IF;

  -- Find consultation service
  SELECT id, unit_price INTO v_consultation_service_id, v_consultation_fee
  FROM medical_services
  WHERE facility_id = p_facility_id
    AND service_category = 'consultation'
    AND service_type = p_visit_type
    AND is_active = true
  LIMIT 1;

  IF v_consultation_service_id IS NULL THEN
    SELECT id, unit_price INTO v_consultation_service_id, v_consultation_fee
    FROM medical_services
    WHERE facility_id = p_facility_id
      AND service_category = 'consultation'
      AND is_active = true
    LIMIT 1;
  END IF;

  IF v_consultation_service_id IS NULL THEN
    RAISE EXCEPTION 'No consultation service configured for this facility. Please contact your facility administrator to set up consultation services before registering patients.';
  END IF;

  -- Construct full name
  v_full_name := trim(p_first_name || ' ' || p_middle_name || ' ' || p_last_name);

  -- Insert patient
  INSERT INTO patients (
    tenant_id, facility_id, first_name, middle_name, last_name,
    full_name, gender, age, date_of_birth, phone, fayida_id,
    region, woreda_subcity, ketena_gott, kebele, house_number,
    residence, occupation
  ) VALUES (
    v_tenant_id, p_facility_id, p_first_name, p_middle_name, p_last_name,
    v_full_name, p_gender, p_age, p_date_of_birth, p_phone, p_fayida_id,
    p_region, p_woreda_subcity, p_ketena_gott, p_kebele, p_house_number,
    p_residence, p_occupation
  ) RETURNING id INTO v_patient_id;

  -- Insert visit with validated FKs
  INSERT INTO visits (
    tenant_id, facility_id, patient_id, visit_type, 
    visit_date, status, registered_by,
    program_id, creditor_id, insurance_provider_id, insurance_policy_number,
    fee_paid
  ) VALUES (
    v_tenant_id, p_facility_id, v_patient_id, p_visit_type,
    CURRENT_TIMESTAMP, 'registered', p_user_id,
    v_final_program_id, v_final_creditor_id, v_final_insurer_id, p_insurance_policy_number,
    CASE 
      WHEN p_consultation_payment_type IN ('free', 'insured') THEN true
      ELSE false
    END
  ) RETURNING id INTO v_visit_id;

  -- Insert billing item for consultation
  INSERT INTO billing_items (
    tenant_id, patient_id, visit_id, service_id,
    unit_price, quantity, total_amount,
    payment_status, created_by,
    payment_mode
  ) VALUES (
    v_tenant_id, v_patient_id, v_visit_id, v_consultation_service_id,
    v_consultation_fee, 1, v_consultation_fee,
    CASE 
      WHEN p_consultation_payment_type IN ('free', 'insured') THEN 'paid'
      ELSE 'unpaid'
    END,
    p_user_id,
    p_consultation_payment_type
  );

  -- Return result with warnings if any
  RETURN jsonb_build_object(
    'patient_id', v_patient_id,
    'visit_id', v_visit_id,
    'full_name', v_full_name,
    'warnings', v_warnings
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Seed default master data for facilities with empty tables
-- Only seed if admin user exists in users table
INSERT INTO programs (tenant_id, facility_id, name, code, is_active, created_by)
SELECT DISTINCT
  f.tenant_id,
  f.id as facility_id,
  'General Free Service Program',
  'FREE_001',
  true,
  u.id
FROM facilities f
JOIN users u ON u.auth_user_id = f.admin_user_id
WHERE NOT EXISTS (
  SELECT 1 FROM programs p 
  WHERE p.tenant_id = f.tenant_id 
  AND (p.facility_id = f.id OR p.facility_id IS NULL)
);

INSERT INTO creditors (tenant_id, facility_id, name, code, is_active, created_by)
SELECT DISTINCT
  f.tenant_id,
  f.id as facility_id,
  'Standard Credit Arrangement',
  'CREDIT_001',
  true,
  u.id
FROM facilities f
JOIN users u ON u.auth_user_id = f.admin_user_id
WHERE NOT EXISTS (
  SELECT 1 FROM creditors c 
  WHERE c.tenant_id = f.tenant_id 
  AND (c.facility_id = f.id OR c.facility_id IS NULL)
);

INSERT INTO insurers (tenant_id, facility_id, name, code, is_active, created_by)
SELECT DISTINCT
  f.tenant_id,
  f.id as facility_id,
  'Self-Pay (No Insurance)',
  'SELF_001',
  true,
  u.id
FROM facilities f
JOIN users u ON u.auth_user_id = f.admin_user_id
WHERE NOT EXISTS (
  SELECT 1 FROM insurers i 
  WHERE i.tenant_id = f.tenant_id 
  AND (i.facility_id = f.id OR i.facility_id IS NULL)
);