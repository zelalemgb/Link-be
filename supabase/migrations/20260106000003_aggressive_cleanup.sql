-- Migration: Cleanup ANY automated/legacy billing items for unpaid visits
-- Description: Removes invalid "Dressing" and "Consultation" fees for registered patients who haven't paid yet.
-- Safety: Only targets visits in 'registered' or 'at_triage' status to avoid deleting doctor-ordered items (which happen in 'in_consultation').

DELETE FROM public.billing_items bi
USING public.visits v
WHERE bi.visit_id = v.id
  AND bi.payment_status = 'unpaid'
  -- SAFETY: Only target visits that are still in early stages.
  -- Once a patient sees a doctor ('in_consultation'), we assume added items are valid orders.
  AND v.status IN ('registered', 'at_triage')
  
  -- Target the specific "ghost" items
  AND (
    -- 1. Generic Consultations without a service ID (Legacy Trigger)
    (bi.category = 'Consultation' AND bi.service_id IS NULL)
    OR
    -- 2. "Dressing" items that appear at registration (Unknown source/Legacy)
    (bi.service_name ILIKE '%Dressing%')
    OR
    -- 3. Duplicate Consultations (if service_id IS NOT NULL but we have multiple? Hard to differentiate, so skipping for now)
    -- But we can remove "Consultation" named items if they are duplicates. 
    -- For now, let's trust the service_id NULL check + Dressing.
    
    -- ADDITIONAL SAFETY: Ensure we don't delete the "Good" consultation fee we just added (if any).
    -- The bad items often have NULL service_id. The good ones have service_id.
    -- BUT if "Dressing" has a service_id (because it Matched 'Minor Wound Dressing'), we still want to delete it 
    -- if it's at registration stage.
    -- So the condition (bi.service_name ILIKE '%Dressing%') is correct for this stage.
    1=0 -- Placeholder to chain ORs nicely if I edit
  );

-- Actually, let's be more precise with the OR logic above.
DELETE FROM public.billing_items bi
USING public.visits v
WHERE bi.visit_id = v.id
  AND bi.payment_status = 'unpaid'
  AND v.status IN ('registered', 'at_triage')
  AND (
    -- Remove Legacy Consultations (Generic)
    (bi.category = 'Consultation' AND bi.service_id IS NULL)
    OR
    -- Remove Unexpected Procedures at Registration (e.g. Dressing)
    (bi.service_name ILIKE '%Dressing%')
  );
