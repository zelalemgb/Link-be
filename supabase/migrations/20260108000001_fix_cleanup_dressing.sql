-- Fix cleanup: previously failed because billing_items does not have service_name column
-- We must join medical_services to find the name

DELETE FROM public.billing_items bi
USING public.medical_services ms
WHERE bi.service_id = ms.id
  AND ms.name ILIKE '%Dressing%'
  AND bi.payment_status = 'unpaid'
  -- Optional: Restrict to recent items or specific visit statuses if needed, 
  -- but generally we want to remove ALL unpaid auto-added dressings.
  -- To be safe, we can check if a consultation fee DOES exist for the same visit, 
  -- but strictly speaking, if 'Dressing' is not supposed to be there at registration, just nuke it.
  ;
