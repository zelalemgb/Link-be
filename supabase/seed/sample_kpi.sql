-- Sample KPI seed data with metadata for testing the KPI dashboard.
-- Run in Supabase SQL editor or via psql with an authenticated session.

WITH ctx AS (
  SELECT 
    COALESCE(
      (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1),
      (SELECT id FROM public.tenants ORDER BY created_at LIMIT 1)
    ) AS tenant_id,
    COALESCE(
      get_user_facility_id(),
      (SELECT id FROM public.facilities ORDER BY created_at LIMIT 1)
    ) AS facility_id
),
-- Insert KPI Definitions with metadata
kpi_defs AS (
  INSERT INTO public.kpi_definitions (
    tenant_id, kpi_code, kpi_name, kpi_description, kpi_category,
    calculation_method, calculation_formula, aggregation_type,
    unit, display_format, has_target, target_direction,
    measurement_frequency, scope_level, is_active, is_published
  )
  SELECT
    ctx.tenant_id,
    v.kpi_code,
    v.kpi_name,
    v.kpi_description,
    v.kpi_category,
    v.calculation_method,
    v.calculation_formula,
    v.aggregation_type,
    v.unit,
    v.display_format,
    v.has_target,
    v.target_direction,
    v.measurement_frequency,
    v.scope_level,
    true,
    true
  FROM ctx
  CROSS JOIN (VALUES
    ('OPD_WAIT_TIME', 'Average OPD Wait Time', 'Average time patients wait before seeing a doctor in outpatient department', 
     'patient_flow', 'average', 'SUM(wait_time_minutes) / COUNT(visits)', 'avg', 
     'minutes', '0.0', true, 'lower', 'daily', 'facility'),
    ('BED_OCCUPANCY', 'Bed Occupancy Rate', 'Percentage of available beds currently occupied by patients',
     'resource_utilization', 'percentage', '(occupied_beds / total_beds) * 100', 'avg',
     '%', '0.0%', true, 'higher', 'daily', 'facility'),
    ('LAB_TAT', 'Lab Turnaround Time', 'Average time from sample collection to result delivery',
     'operational', 'average', 'AVG(result_time - collection_time)', 'avg',
     'hours', '0.0', true, 'lower', 'daily', 'facility'),
    ('PATIENT_SATISFACTION', 'Patient Satisfaction Score', 'Average patient satisfaction rating from feedback surveys',
     'quality', 'average', 'AVG(satisfaction_score)', 'avg',
     'score', '0.0', true, 'higher', 'weekly', 'facility'),
    ('MEDICATION_ERROR_RATE', 'Medication Error Rate', 'Number of medication errors per 1000 prescriptions dispensed',
     'safety', 'rate', '(medication_errors / prescriptions) * 1000', 'sum',
     'per 1000', '0.00', true, 'lower', 'monthly', 'facility'),
    ('REVENUE_PER_VISIT', 'Revenue per Patient Visit', 'Average revenue generated per outpatient visit',
     'financial', 'average', 'total_revenue / total_visits', 'sum',
     'ETB', '0.00', true, 'higher', 'daily', 'facility'),
    ('STAFF_UTILIZATION', 'Staff Utilization Rate', 'Percentage of staff time spent on direct patient care activities',
     'resource_utilization', 'percentage', '(care_hours / total_hours) * 100', 'avg',
     '%', '0.0%', true, 'higher', 'weekly', 'facility'),
    ('READMISSION_RATE', 'Readmission Rate (30-day)', 'Percentage of patients readmitted within 30 days of discharge',
     'quality', 'percentage', '(readmissions / discharges) * 100', 'avg',
     '%', '0.0%', true, 'lower', 'monthly', 'facility')
  ) AS v(kpi_code, kpi_name, kpi_description, kpi_category, calculation_method, calculation_formula, aggregation_type, unit, display_format, has_target, target_direction, measurement_frequency, scope_level)
  ON CONFLICT (tenant_id, kpi_code) DO NOTHING
  RETURNING id, kpi_code, tenant_id
),
-- Also get existing definitions for the target/value inserts
existing_defs AS (
  SELECT id, kpi_code, tenant_id
  FROM public.kpi_definitions
  WHERE tenant_id = (SELECT tenant_id FROM ctx LIMIT 1)
),
all_defs AS (
  SELECT * FROM kpi_defs
  UNION ALL
  SELECT * FROM existing_defs
),
-- Insert KPI Targets with thresholds
insert_targets AS (
  INSERT INTO public.kpi_targets (
    tenant_id, kpi_definition_id, facility_id,
    effective_from, target_value, threshold_red, threshold_yellow, threshold_green,
    target_type, benchmark_source, notes
  )
  SELECT
    d.tenant_id,
    d.id,
    ctx.facility_id,
    CURRENT_DATE,
    t.target_value,
    t.threshold_red,
    t.threshold_yellow,
    t.threshold_green,
    'facility_specific',
    t.benchmark_source,
    t.notes
  FROM all_defs d
  CROSS JOIN ctx
  JOIN (VALUES
    ('OPD_WAIT_TIME', 30, 60, 45, 30, 'WHO Guidelines', 'Target based on WHO recommended waiting times'),
    ('BED_OCCUPANCY', 85, 95, 90, 85, 'Internal', 'Optimal occupancy rate for efficiency and quality'),
    ('LAB_TAT', 4, 8, 6, 4, 'CAP Standards', 'College of American Pathologists benchmarks'),
    ('PATIENT_SATISFACTION', 4.5, 3.0, 3.5, 4.0, 'Press Ganey', 'Industry standard patient satisfaction benchmarks'),
    ('MEDICATION_ERROR_RATE', 0.5, 2.0, 1.0, 0.5, 'ISMP', 'Institute for Safe Medication Practices guidelines'),
    ('REVENUE_PER_VISIT', 500, 300, 400, 500, 'Internal', 'Based on historical performance and cost analysis'),
    ('STAFF_UTILIZATION', 75, 50, 60, 70, 'Internal', 'Balanced for quality care and staff wellbeing'),
    ('READMISSION_RATE', 5, 15, 10, 5, 'CMS', 'Centers for Medicare & Medicaid Services benchmarks')
  ) AS t(kpi_code, target_value, threshold_red, threshold_yellow, threshold_green, benchmark_source, notes)
    ON t.kpi_code = d.kpi_code
  WHERE NOT EXISTS (
    SELECT 1 FROM public.kpi_targets kt
    WHERE kt.kpi_definition_id = d.id 
      AND kt.facility_id = ctx.facility_id
      AND kt.effective_from = CURRENT_DATE
  )
  RETURNING id
),
-- Insert KPI Values with calculation metadata (sample data for last 30 days)
insert_values AS (
  INSERT INTO public.kpi_values (
    tenant_id, kpi_definition_id, facility_id,
    measurement_date, measurement_timestamp, period_start, period_end,
    value, numerator, denominator, target_value, variance, variance_percentage,
    status, calculation_metadata, data_quality_score
  )
  SELECT
    d.tenant_id,
    d.id,
    ctx.facility_id,
    day_offset.dt::date,
    day_offset.dt,
    day_offset.dt,
    day_offset.dt + interval '1 day',
    v.base_value + (random() * v.variance_range - v.variance_range/2),
    CASE WHEN v.show_components THEN v.base_numerator + (random() * 20 - 10) ELSE NULL END,
    CASE WHEN v.show_components THEN v.base_denominator + (random() * 10 - 5) ELSE NULL END,
    v.target_val,
    (v.base_value + (random() * v.variance_range - v.variance_range/2)) - v.target_val,
    ((v.base_value + (random() * v.variance_range - v.variance_range/2)) - v.target_val) / v.target_val * 100,
    CASE 
      WHEN random() > 0.7 THEN 'red'
      WHEN random() > 0.4 THEN 'yellow'
      ELSE 'green'
    END,
    jsonb_build_object(
      'source', v.data_source,
      'calculation_time_ms', floor(random() * 500 + 100),
      'records_processed', floor(random() * 1000 + 100),
      'algorithm_version', '1.2.0',
      'confidence_interval', jsonb_build_object('lower', v.base_value * 0.95, 'upper', v.base_value * 1.05),
      'data_completeness', 0.85 + (random() * 0.15),
      'excluded_records', floor(random() * 10),
      'exclusion_reasons', ARRAY['missing_data', 'outlier_detected'],
      'last_sync', now() - (random() * interval '1 hour')
    ),
    0.85 + (random() * 0.15)
  FROM all_defs d
  CROSS JOIN ctx
  CROSS JOIN generate_series(
    CURRENT_DATE - interval '30 days',
    CURRENT_DATE,
    interval '1 day'
  ) AS day_offset(dt)
  JOIN (VALUES
    ('OPD_WAIT_TIME', 35, 20, 30, true, 350, 10, 'visit_queue_system'),
    ('BED_OCCUPANCY', 82, 15, 85, true, 82, 100, 'bed_management_system'),
    ('LAB_TAT', 4.5, 2, 4, true, 180, 40, 'lab_information_system'),
    ('PATIENT_SATISFACTION', 4.2, 0.8, 4.5, true, 420, 100, 'survey_system'),
    ('MEDICATION_ERROR_RATE', 0.8, 0.5, 0.5, true, 8, 10000, 'pharmacy_system'),
    ('REVENUE_PER_VISIT', 480, 100, 500, false, NULL, NULL, 'billing_system'),
    ('STAFF_UTILIZATION', 72, 15, 75, true, 288, 400, 'hr_system'),
    ('READMISSION_RATE', 6.5, 3, 5, true, 13, 200, 'ehr_system')
  ) AS v(kpi_code, base_value, variance_range, target_val, show_components, base_numerator, base_denominator, data_source)
    ON v.kpi_code = d.kpi_code
  WHERE NOT EXISTS (
    SELECT 1 FROM public.kpi_values kv
    WHERE kv.kpi_definition_id = d.id 
      AND kv.facility_id = ctx.facility_id
      AND kv.measurement_date = day_offset.dt::date
  )
  RETURNING id
)
SELECT
  'KPI seed completed' AS status,
  (SELECT count(*) FROM all_defs) AS definitions_available,
  (SELECT count(*) FROM insert_targets) AS targets_inserted,
  (SELECT count(*) FROM insert_values) AS values_inserted;

-- Verify with: 
-- SELECT kd.kpi_code, kd.kpi_name, count(kv.id) as value_count, avg(kv.value) as avg_value 
-- FROM kpi_definitions kd 
-- LEFT JOIN kpi_values kv ON kv.kpi_definition_id = kd.id 
-- GROUP BY kd.id ORDER BY kd.kpi_code;
