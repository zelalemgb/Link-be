
-- Check for triggers on the visits table
SELECT 
    trigger_name, 
    event_manipulation, 
    event_object_table, 
    action_statement 
FROM information_schema.triggers 
WHERE event_object_table = 'visits';

-- Check for services that might be mistakenly matched
SELECT id, name, category, price, is_active 
FROM medical_services 
WHERE category = 'Consultation' 
   OR name ILIKE '%follow%' 
   OR name ILIKE '%dressing%';
