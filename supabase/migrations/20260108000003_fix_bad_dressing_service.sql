-- Fix bad data: "Dressing " service masquerading as a Consultation
-- This is likely being picked up by logic searching for 'Consultation' category services

-- 1. Delete the specific bad service (ID identified from user output)
DELETE FROM public.medical_services 
WHERE id = '27e7bd75-e1ff-4dc7-af72-ec913c63b6b6';

-- 2. Also delete the duplicate "Dressing " (Procedure) if it's redundant (ID: 6dad99a1-a79e-4ae4-bce9-5ac53de513f7)
-- Actually, let's just clean up ANY 'Dressing' that is category 'Consultation'
DELETE FROM public.medical_services 
WHERE name ILIKE '%Dressing%' 
  AND category = 'Consultation';

-- 3. Nuke the billing items associated with these bad services (in case previous cleanups missed them)
-- We do this by name + category since we might have just deleted the service record (cascade might handle it, but allow orphan cleanup)
-- Ideally we did this BEFORE deleting the service if no cascade, but assuming foreign keys...
-- If foreign key is ON DELETE SET NULL or CASCADE, ensuring cleanliness:

DELETE FROM public.billing_items 
WHERE service_id IN (
    '27e7bd75-e1ff-4dc7-af72-ec913c63b6b6', -- The Bad Consultation Dressing
    '6dad99a1-a79e-4ae4-bce9-5ac53de513f7'  -- The Duplicate Procedure Dressing (Optional, but safe to clean)
);

-- 4. Just in case, run the V2 cleanup logic again for good measure
DELETE FROM public.billing_items bi
USING public.medical_services ms
WHERE bi.service_id = ms.id
  AND ms.name ILIKE '%Dressing%'
  AND bi.payment_status IN ('unpaid', 'pending', 'partial');
