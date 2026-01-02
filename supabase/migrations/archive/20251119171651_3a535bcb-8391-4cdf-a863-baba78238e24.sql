-- Fix patients stuck in paying_* stages with completed payments
-- This is a one-time fix for patients who were paid before the auto-update trigger was created

-- Update Hilina Abate Abate: paying_consultation -> at_triage
UPDATE visits
SET 
  status = 'at_triage',
  updated_at = NOW()
WHERE id = '1f2709ed-046e-434b-852c-eec5cd28f586'
  AND status = 'paying_consultation';

-- Update Kidus Zelalem Gizachew: paying_pharmacy -> at_pharmacy  
UPDATE visits
SET 
  status = 'at_pharmacy',
  updated_at = NOW()
WHERE id = '58fc0b75-6194-4e26-9d85-b793d46b07af'
  AND status = 'paying_pharmacy';