-- Sample KPI definitions for beta testing
-- Run this directly in Supabase SQL Editor

DO $$
DECLARE
  v_facility_id uuid;
  v_tenant_id uuid;
  v_user_id uuid;
  v_kpi_id uuid;
BEGIN
  -- Get first facility and tenant
  SELECT id, tenant_id INTO v_facility_id, v_tenant_id
  FROM public.facilities
  ORDER BY created_at
  LIMIT 1;

  IF v_facility_id IS NULL THEN
    RAISE EXCEPTION 'No facility found. Please create a facility first.';
  END IF;

  -- Get a user for created_by
  SELECT id INTO v_user_id
  FROM public.users
  WHERE tenant_id = v_tenant_id
  LIMIT 1;

  -- Insert KPI Definitions
  -- 1. Average Wait Time
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'AVG_WAIT_TIME', 'Average Wait Time', 'Average time from patient arrival to first clinical contact', 'Access & Timeliness', 'Time difference from check-in to triage start', 'minutes', true, 'lower', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 15, 30, 20, 15)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 2. Triage Wait Time
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'TRIAGE_WAIT', 'Triage Wait Time', 'Average time patients wait for triage assessment', 'Access & Timeliness', 'Time from reception to triage completion', 'minutes', true, 'lower', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 10, 20, 15, 10)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 3. Doctor Wait Time
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'DOCTOR_WAIT', 'Doctor Wait Time', 'Average time from triage to doctor consultation', 'Access & Timeliness', 'Time from triage completion to doctor start', 'minutes', true, 'lower', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 20, 45, 30, 20)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 4. Daily Patient Visits
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'DAILY_VISITS', 'Daily Patient Visits', 'Total number of patient visits per day', 'Patient Flow', 'Count of visits created today', 'count', true, 'higher', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 50, 20, 35, 50)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 5. Visit Completion Rate
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'COMPLETION_RATE', 'Visit Completion Rate', 'Percentage of visits completed same day', 'Patient Flow', 'Completed visits / Total visits * 100', 'percent', true, 'higher', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 85, 60, 75, 85)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 6. Average Length of Stay
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'AVG_LOS', 'Average Length of Stay', 'Average total time from arrival to discharge', 'Patient Flow', 'Average duration of completed visits', 'minutes', true, 'lower', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 90, 180, 120, 90)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 7. Payment Collection Rate
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'COLLECTION_RATE', 'Payment Collection Rate', 'Percentage of billed amount collected', 'Financial', 'Collected amount / Billed amount * 100', 'percent', true, 'higher', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 90, 70, 80, 90)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 8. Daily Revenue
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'DAILY_REVENUE', 'Daily Revenue', 'Total revenue collected per day', 'Financial', 'Sum of all payments collected', 'ETB', true, 'higher', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 50000, 20000, 35000, 50000)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 9. Lab Turnaround Time
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'LAB_TAT', 'Lab Turnaround Time', 'Average time from sample collection to result', 'Clinical Quality', 'Time from sample to result available', 'minutes', true, 'lower', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 60, 120, 90, 60)
    ON CONFLICT DO NOTHING;
  END IF;

  -- 10. Imaging Turnaround Time
  INSERT INTO public.kpi_definitions (tenant_id, kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, unit, has_target, target_direction, measurement_frequency, scope_level, is_active, is_published, created_by)
  VALUES (v_tenant_id, 'IMAGING_TAT', 'Imaging Turnaround Time', 'Average time from imaging order to report', 'Clinical Quality', 'Time from order to report available', 'minutes', true, 'lower', 'daily', 'facility', true, true, v_user_id)
  ON CONFLICT (kpi_code, tenant_id) DO NOTHING
  RETURNING id INTO v_kpi_id;
  
  IF v_kpi_id IS NOT NULL THEN
    INSERT INTO public.kpi_targets (kpi_id, facility_id, effective_from, target_value, threshold_red, threshold_yellow, threshold_green)
    VALUES (v_kpi_id, v_facility_id, CURRENT_DATE, 45, 90, 60, 45)
    ON CONFLICT DO NOTHING;
  END IF;

  -- Insert sample KPI values for the last 7 days
  FOR i IN 0..6 LOOP
    -- AVG_WAIT_TIME
    SELECT id INTO v_kpi_id FROM public.kpi_definitions WHERE kpi_code = 'AVG_WAIT_TIME' AND tenant_id = v_tenant_id;
    IF v_kpi_id IS NOT NULL THEN
      INSERT INTO public.kpi_values (kpi_id, facility_id, value, recorded_at, status)
      VALUES (v_kpi_id, v_facility_id, 15 + floor(random() * 10), CURRENT_DATE - i, CASE WHEN random() > 0.5 THEN 'green' ELSE 'yellow' END)
      ON CONFLICT DO NOTHING;
    END IF;

    -- DAILY_VISITS
    SELECT id INTO v_kpi_id FROM public.kpi_definitions WHERE kpi_code = 'DAILY_VISITS' AND tenant_id = v_tenant_id;
    IF v_kpi_id IS NOT NULL THEN
      INSERT INTO public.kpi_values (kpi_id, facility_id, value, recorded_at, status)
      VALUES (v_kpi_id, v_facility_id, 40 + floor(random() * 25), CURRENT_DATE - i, CASE WHEN random() > 0.4 THEN 'green' ELSE 'yellow' END)
      ON CONFLICT DO NOTHING;
    END IF;

    -- COLLECTION_RATE
    SELECT id INTO v_kpi_id FROM public.kpi_definitions WHERE kpi_code = 'COLLECTION_RATE' AND tenant_id = v_tenant_id;
    IF v_kpi_id IS NOT NULL THEN
      INSERT INTO public.kpi_values (kpi_id, facility_id, value, recorded_at, status)
      VALUES (v_kpi_id, v_facility_id, 80 + floor(random() * 15), CURRENT_DATE - i, CASE WHEN random() > 0.3 THEN 'green' ELSE 'yellow' END)
      ON CONFLICT DO NOTHING;
    END IF;

    -- DAILY_REVENUE
    SELECT id INTO v_kpi_id FROM public.kpi_definitions WHERE kpi_code = 'DAILY_REVENUE' AND tenant_id = v_tenant_id;
    IF v_kpi_id IS NOT NULL THEN
      INSERT INTO public.kpi_values (kpi_id, facility_id, value, recorded_at, status)
      VALUES (v_kpi_id, v_facility_id, 35000 + floor(random() * 25000), CURRENT_DATE - i, CASE WHEN random() > 0.4 THEN 'green' ELSE 'yellow' END)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  RAISE NOTICE 'KPI definitions and sample data seeded successfully!';
END $$;

-- Show results
SELECT 
  'KPI Summary' AS info,
  (SELECT COUNT(*) FROM kpi_definitions) AS definitions,
  (SELECT COUNT(*) FROM kpi_targets) AS targets,
  (SELECT COUNT(*) FROM kpi_values) AS values;
