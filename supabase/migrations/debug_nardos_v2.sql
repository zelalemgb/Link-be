
SELECT 
  p.first_name || ' ' || p.last_name as patient_name,
  v.id as visit_id, 
  v.status as visit_status,
  v.visit_date,
  bi.id as billing_item_id, 
  bi.payment_status, 
  bi.total_amount,
  bi.created_at,
  ms.name as service_name,
  ms.category as service_category
FROM visits v
JOIN patients p ON v.patient_id = p.id
JOIN billing_items bi ON v.id = bi.visit_id
LEFT JOIN medical_services ms ON bi.service_id = ms.id
WHERE p.first_name ILIKE '%Nardos%' OR p.last_name ILIKE '%Nardos%'
ORDER BY bi.created_at DESC;
