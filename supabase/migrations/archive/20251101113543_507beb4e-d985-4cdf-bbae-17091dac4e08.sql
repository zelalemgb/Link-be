-- Seed medical_services table with default consultation services
-- This ensures all facilities have basic consultation services available

DO $$
DECLARE
  facility_record RECORD;
  creator_user_id uuid;
BEGIN
  -- Loop through all active facilities
  FOR facility_record IN 
    SELECT id, admin_user_id FROM facilities WHERE verified = true
  LOOP
    -- Get a valid user ID for created_by field
    -- Prefer admin_user_id if available, otherwise get any user from the facility
    IF facility_record.admin_user_id IS NOT NULL THEN
      creator_user_id := facility_record.admin_user_id;
    ELSE
      SELECT id INTO creator_user_id 
      FROM users 
      WHERE facility_id = facility_record.id 
      LIMIT 1;
    END IF;
    
    -- Skip if no user found for this facility
    CONTINUE WHEN creator_user_id IS NULL;
    
    -- Insert default consultation services for each facility
    
    -- New Patient Consultation
    INSERT INTO public.medical_services (
      facility_id,
      name,
      category,
      description,
      price,
      is_active,
      created_by
    )
    SELECT
      facility_record.id,
      'New Patient Consultation',
      'Consultation',
      'Initial consultation for new patients',
      200.00,
      true,
      creator_user_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.medical_services 
      WHERE facility_id = facility_record.id 
      AND category = 'Consultation' 
      AND name ILIKE '%new%patient%'
    );
    
    -- Follow-up Consultation
    INSERT INTO public.medical_services (
      facility_id,
      name,
      category,
      description,
      price,
      is_active,
      created_by
    )
    SELECT
      facility_record.id,
      'Follow-up Consultation',
      'Consultation',
      'Follow-up visit consultation',
      100.00,
      true,
      creator_user_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.medical_services 
      WHERE facility_id = facility_record.id 
      AND category = 'Consultation' 
      AND name ILIKE '%follow%up%'
    );
    
    -- Returning Patient Consultation
    INSERT INTO public.medical_services (
      facility_id,
      name,
      category,
      description,
      price,
      is_active,
      created_by
    )
    SELECT
      facility_record.id,
      'Returning Patient Consultation',
      'Consultation',
      'Consultation for returning patients',
      150.00,
      true,
      creator_user_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.medical_services 
      WHERE facility_id = facility_record.id 
      AND category = 'Consultation' 
      AND name ILIKE '%returning%'
    );
    
    -- Emergency Consultation
    INSERT INTO public.medical_services (
      facility_id,
      name,
      category,
      description,
      price,
      is_active,
      created_by
    )
    SELECT
      facility_record.id,
      'Emergency Consultation',
      'Consultation',
      'Emergency consultation service',
      300.00,
      true,
      creator_user_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.medical_services 
      WHERE facility_id = facility_record.id 
      AND category = 'Consultation' 
      AND name ILIKE '%emergency%'
    );
    
  END LOOP;
END $$;