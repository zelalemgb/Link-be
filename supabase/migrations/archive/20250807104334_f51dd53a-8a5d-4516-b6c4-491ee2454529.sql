-- Fix existing visits that have NULL facility_id by setting them to match the facility_id of the user who created them
UPDATE visits 
SET facility_id = u.facility_id 
FROM users u 
WHERE visits.created_by = u.id 
  AND visits.facility_id IS NULL 
  AND u.facility_id IS NOT NULL;