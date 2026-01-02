-- Ensure function exists to auto-update visit status when consultation billing_items are paid
CREATE OR REPLACE FUNCTION public.auto_update_visit_status_on_consultation_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_service_category text;
BEGIN
  -- Only process when payment_status changes to 'paid'
  IF NEW.payment_status = 'paid' AND (OLD.payment_status IS NULL OR OLD.payment_status != 'paid') THEN
    -- Check if this is a consultation service
    SELECT ms.category INTO v_service_category
    FROM public.medical_services ms
    WHERE ms.id = NEW.service_id;

    IF v_service_category = 'Consultation' THEN
      -- Update visit status to at_triage and set fee_paid
      UPDATE public.visits
      SET status = 'at_triage',
          status_updated_at = now(),
          fee_paid = COALESCE(NEW.total_amount, 0)
      WHERE id = NEW.visit_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop and recreate trigger to avoid duplicates
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trigger_auto_update_visit_status_on_consultation_payment'
  ) THEN
    DROP TRIGGER trigger_auto_update_visit_status_on_consultation_payment ON public.billing_items;
  END IF;
END $$;

CREATE TRIGGER trigger_auto_update_visit_status_on_consultation_payment
  AFTER UPDATE ON public.billing_items
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_update_visit_status_on_consultation_payment();

-- One-time backfill: for existing visits stuck at 'paying_consultation' with a paid consultation billing item,
-- move them to 'at_triage' so they show in the Nurse Dashboard queue
WITH paid_consult AS (
  SELECT bi.visit_id,
         SUM(COALESCE(bi.total_amount,0)) AS sum_paid
  FROM public.billing_items bi
  JOIN public.medical_services ms ON ms.id = bi.service_id
  WHERE bi.payment_status = 'paid'
    AND ms.category = 'Consultation'
  GROUP BY bi.visit_id
)
UPDATE public.visits v
SET status = 'at_triage',
    status_updated_at = now(),
    fee_paid = COALESCE(NULLIF(v.fee_paid, 0), 0) + COALESCE(pc.sum_paid, 0)
FROM paid_consult pc
WHERE v.id = pc.visit_id
  AND v.status = 'paying_consultation';