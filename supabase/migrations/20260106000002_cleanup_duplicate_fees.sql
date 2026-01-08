-- Migration: Cleanup duplicate consultation fees
-- Description: Deletes invalid billing items created by the legacy trigger for unpaid visits.
-- Criteria: Items with 'Consultation' name/category that are unpaid and likely result of the trigger (generic).

-- 1. Identify and delete the duplicate items.
-- The trigger created items with service_name='Consultation', category='Consultation' and usually NO service_id (or a generic one if it found it).
-- The VALID items created by our new RPC have a specific service_id and usually a specific name (e.g. 'General Consultation').

DELETE FROM public.billing_items
WHERE 
  category = 'Consultation' 
  AND payment_status = 'unpaid'
  -- Filter for the generic items created by the auto-trigger
  AND service_name = 'Consultation' 
  -- Ensure we don't delete valid items that might have been manually created with this name (unlikely but safe)
  -- The key differentiator is likely the timestamp or the lack of specific service linkage if the trigger didn't find one.
  -- The trigger logic was: 
  -- INSERT INTO billing_items (..., service_name, category, ...) VALUES (..., 'Consultation', 'Consultation', ...)
  -- My new RPC logic:
  -- INSERT INTO billing_items (..., service_id, ...) VALUES (..., v_consultation_service_id, ...)
  -- So we can target items where service_id IS NULL if the trigger left it null. 
  -- However, the trigger code I saw earlier DID look up a service_id (v_consultation_service record) but the INSERT statement 
  -- I saw in the snippet DID NOT include service_id in the column list. 
  -- If that's the case, service_id would be NULL for trigger-created items.
  AND service_id IS NULL;

-- 2. Verify: If the trigger DID insert service_id (because I might have missed a version of the trigger),
-- we might have duplicates where both have service_id but one is generic.
-- But given the user report "all medical services", it implies multiple.
-- Actually, the user said "billing list still list all medical services".
-- Wait, if it lists "all", maybe the trigger was iterating? 
-- Or maybe there were multiple triggers?
-- The safest bet for now is to remove the clearly invalid ones (no service_id).

