
-- Find the patient
SELECT * FROM patients WHERE first_name ILIKE '%Nardos%' OR last_name ILIKE '%Nardos%';

-- Find billing items with full details
-- We use LEFT JOIN to see the service name if it exists.
-- We select * from billing_items to see all columns (including potential legacy ones).
SELECT 
  bi.*, 
  ms.name as service_name_joined,
  v.status as visit_status
FROM billing_items bi
JOIN visits v ON bi.visit_id = v.id
LEFT JOIN medical_services ms ON bi.service_id = ms.id
WHERE v.patient_id IN (
  SELECT id FROM patients WHERE first_name ILIKE '%Nardos%' OR last_name ILIKE '%Nardos%'
);
