-- Force cleanup v2: Include 'pending' and 'partial' statuses
-- And double check against service name

DELETE FROM public.billing_items bi
USING public.medical_services ms
WHERE bi.service_id = ms.id
  AND ms.name ILIKE '%Dressing%'
  AND bi.payment_status IN ('unpaid', 'pending', 'partial');

-- Just in case there are orphaned items without a service link (unlikely but possible if service was deleted)
-- and IF there was a service_name column (which we think there isn't, but safe to try via dynamic SQL if we could, but we can't).
-- So we rely on the JOIN. 

-- Also, specifically for today's duplicates that might have a slightly different name?
-- No, user confirmed "Dressing".
