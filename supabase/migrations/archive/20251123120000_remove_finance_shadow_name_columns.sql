BEGIN;

-- Backfill insurance provider IDs for medication orders using existing name columns
UPDATE public.medication_orders mo
SET insurance_provider_id = ins.id
FROM public.visits v
JOIN public.insurers ins
  ON ins.tenant_id = mo.tenant_id
  AND (ins.facility_id = v.facility_id OR ins.facility_id IS NULL)
  AND ins.name = btrim(mo.insurance_provider_name)
WHERE mo.visit_id = v.id
  AND mo.insurance_provider_id IS NULL
  AND mo.insurance_provider_name IS NOT NULL
  AND btrim(mo.insurance_provider_name) <> '';

-- Backfill creditor IDs for medication orders
UPDATE public.medication_orders mo
SET creditor_id = cr.id
FROM public.visits v
JOIN public.creditors cr
  ON cr.tenant_id = mo.tenant_id
  AND (cr.facility_id = v.facility_id OR cr.facility_id IS NULL)
  AND cr.name = btrim(mo.creditor_name)
WHERE mo.visit_id = v.id
  AND mo.creditor_id IS NULL
  AND mo.creditor_name IS NOT NULL
  AND btrim(mo.creditor_name) <> '';

-- Backfill program IDs for medication orders
UPDATE public.medication_orders mo
SET program_id = pr.id
FROM public.visits v
JOIN public.programs pr
  ON pr.tenant_id = mo.tenant_id
  AND (pr.facility_id = v.facility_id OR pr.facility_id IS NULL)
  AND pr.name = btrim(mo.program_name)
WHERE mo.visit_id = v.id
  AND mo.program_id IS NULL
  AND mo.program_name IS NOT NULL
  AND btrim(mo.program_name) <> '';

-- Backfill insurance provider IDs for lab orders
UPDATE public.lab_orders lo
SET insurance_provider_id = ins.id
FROM public.visits v
JOIN public.insurers ins
  ON ins.tenant_id = lo.tenant_id
  AND (ins.facility_id = v.facility_id OR ins.facility_id IS NULL)
  AND ins.name = btrim(lo.insurance_provider_name)
WHERE lo.visit_id = v.id
  AND lo.insurance_provider_id IS NULL
  AND lo.insurance_provider_name IS NOT NULL
  AND btrim(lo.insurance_provider_name) <> '';

-- Backfill creditor IDs for lab orders
UPDATE public.lab_orders lo
SET creditor_id = cr.id
FROM public.visits v
JOIN public.creditors cr
  ON cr.tenant_id = lo.tenant_id
  AND (cr.facility_id = v.facility_id OR cr.facility_id IS NULL)
  AND cr.name = btrim(lo.creditor_name)
WHERE lo.visit_id = v.id
  AND lo.creditor_id IS NULL
  AND lo.creditor_name IS NOT NULL
  AND btrim(lo.creditor_name) <> '';

-- Backfill program IDs for lab orders
UPDATE public.lab_orders lo
SET program_id = pr.id
FROM public.visits v
JOIN public.programs pr
  ON pr.tenant_id = lo.tenant_id
  AND (pr.facility_id = v.facility_id OR pr.facility_id IS NULL)
  AND pr.name = btrim(lo.program_name)
WHERE lo.visit_id = v.id
  AND lo.program_id IS NULL
  AND lo.program_name IS NOT NULL
  AND btrim(lo.program_name) <> '';

-- Backfill insurance provider IDs for imaging orders
UPDATE public.imaging_orders io
SET insurance_provider_id = ins.id
FROM public.visits v
JOIN public.insurers ins
  ON ins.tenant_id = io.tenant_id
  AND (ins.facility_id = v.facility_id OR ins.facility_id IS NULL)
  AND ins.name = btrim(io.insurance_provider_name)
WHERE io.visit_id = v.id
  AND io.insurance_provider_id IS NULL
  AND io.insurance_provider_name IS NOT NULL
  AND btrim(io.insurance_provider_name) <> '';

-- Backfill creditor IDs for imaging orders
UPDATE public.imaging_orders io
SET creditor_id = cr.id
FROM public.visits v
JOIN public.creditors cr
  ON cr.tenant_id = io.tenant_id
  AND (cr.facility_id = v.facility_id OR cr.facility_id IS NULL)
  AND cr.name = btrim(io.creditor_name)
WHERE io.visit_id = v.id
  AND io.creditor_id IS NULL
  AND io.creditor_name IS NOT NULL
  AND btrim(io.creditor_name) <> '';

-- Backfill program IDs for imaging orders
UPDATE public.imaging_orders io
SET program_id = pr.id
FROM public.visits v
JOIN public.programs pr
  ON pr.tenant_id = io.tenant_id
  AND (pr.facility_id = v.facility_id OR pr.facility_id IS NULL)
  AND pr.name = btrim(io.program_name)
WHERE io.visit_id = v.id
  AND io.program_id IS NULL
  AND io.program_name IS NOT NULL
  AND btrim(io.program_name) <> '';

-- Backfill insurance provider IDs for billing items
UPDATE public.billing_items bi
SET insurance_provider_id = ins.id
FROM public.visits v
JOIN public.insurers ins
  ON ins.tenant_id = bi.tenant_id
  AND (ins.facility_id = v.facility_id OR ins.facility_id IS NULL)
  AND ins.name = btrim(bi.insurance_provider_name)
WHERE bi.visit_id = v.id
  AND bi.insurance_provider_id IS NULL
  AND bi.insurance_provider_name IS NOT NULL
  AND btrim(bi.insurance_provider_name) <> '';

-- Backfill creditor IDs for billing items
UPDATE public.billing_items bi
SET creditor_id = cr.id
FROM public.visits v
JOIN public.creditors cr
  ON cr.tenant_id = bi.tenant_id
  AND (cr.facility_id = v.facility_id OR cr.facility_id IS NULL)
  AND cr.name = btrim(bi.creditor_name)
WHERE bi.visit_id = v.id
  AND bi.creditor_id IS NULL
  AND bi.creditor_name IS NOT NULL
  AND btrim(bi.creditor_name) <> '';

-- Backfill program IDs for billing items
UPDATE public.billing_items bi
SET program_id = pr.id
FROM public.visits v
JOIN public.programs pr
  ON pr.tenant_id = bi.tenant_id
  AND (pr.facility_id = v.facility_id OR pr.facility_id IS NULL)
  AND pr.name = btrim(bi.program_name)
WHERE bi.visit_id = v.id
  AND bi.program_id IS NULL
  AND bi.program_name IS NOT NULL
  AND btrim(bi.program_name) <> '';

-- Backfill creditor IDs for payment line items
UPDATE public.payment_line_items pli
SET creditor_id = cr.id
FROM public.payments pay
JOIN public.creditors cr
  ON cr.tenant_id = pay.tenant_id
  AND (cr.facility_id = pay.facility_id OR cr.facility_id IS NULL)
  AND cr.name = btrim(pli.creditor_name)
WHERE pli.payment_id = pay.id
  AND pli.creditor_id IS NULL
  AND pli.creditor_name IS NOT NULL
  AND btrim(pli.creditor_name) <> '';

-- Backfill program IDs for payment line items
UPDATE public.payment_line_items pli
SET program_id = pr.id
FROM public.payments pay
JOIN public.programs pr
  ON pr.tenant_id = pay.tenant_id
  AND (pr.facility_id = pay.facility_id OR pr.facility_id IS NULL)
  AND pr.name = btrim(pli.program_name)
WHERE pli.payment_id = pay.id
  AND pli.program_id IS NULL
  AND pli.program_name IS NOT NULL
  AND btrim(pli.program_name) <> '';

-- Validate that no rows still depend on shadow name columns before dropping them
DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*) INTO missing_count
  FROM public.medication_orders
  WHERE COALESCE(btrim(insurance_provider_name), '') <> ''
    AND insurance_provider_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop medication_orders.insurance_provider_name; % rows still missing insurer IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.medication_orders
  WHERE COALESCE(btrim(creditor_name), '') <> ''
    AND creditor_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop medication_orders.creditor_name; % rows still missing creditor IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.medication_orders
  WHERE COALESCE(btrim(program_name), '') <> ''
    AND program_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop medication_orders.program_name; % rows still missing program IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.lab_orders
  WHERE COALESCE(btrim(insurance_provider_name), '') <> ''
    AND insurance_provider_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop lab_orders.insurance_provider_name; % rows still missing insurer IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.lab_orders
  WHERE COALESCE(btrim(creditor_name), '') <> ''
    AND creditor_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop lab_orders.creditor_name; % rows still missing creditor IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.lab_orders
  WHERE COALESCE(btrim(program_name), '') <> ''
    AND program_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop lab_orders.program_name; % rows still missing program IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.imaging_orders
  WHERE COALESCE(btrim(insurance_provider_name), '') <> ''
    AND insurance_provider_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop imaging_orders.insurance_provider_name; % rows still missing insurer IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.imaging_orders
  WHERE COALESCE(btrim(creditor_name), '') <> ''
    AND creditor_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop imaging_orders.creditor_name; % rows still missing creditor IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.imaging_orders
  WHERE COALESCE(btrim(program_name), '') <> ''
    AND program_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop imaging_orders.program_name; % rows still missing program IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.billing_items
  WHERE COALESCE(btrim(insurance_provider_name), '') <> ''
    AND insurance_provider_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop billing_items.insurance_provider_name; % rows still missing insurer IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.billing_items
  WHERE COALESCE(btrim(creditor_name), '') <> ''
    AND creditor_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop billing_items.creditor_name; % rows still missing creditor IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.billing_items
  WHERE COALESCE(btrim(program_name), '') <> ''
    AND program_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop billing_items.program_name; % rows still missing program IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.payment_line_items
  WHERE COALESCE(btrim(creditor_name), '') <> ''
    AND creditor_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop payment_line_items.creditor_name; % rows still missing creditor IDs', missing_count;
  END IF;

  SELECT COUNT(*) INTO missing_count
  FROM public.payment_line_items
  WHERE COALESCE(btrim(program_name), '') <> ''
    AND program_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop payment_line_items.program_name; % rows still missing program IDs', missing_count;
  END IF;
END
$$;

-- Drop redundant shadow name columns now that data integrity is confirmed
ALTER TABLE public.medication_orders
  DROP COLUMN IF EXISTS insurance_provider_name,
  DROP COLUMN IF EXISTS creditor_name,
  DROP COLUMN IF EXISTS program_name;

ALTER TABLE public.lab_orders
  DROP COLUMN IF EXISTS insurance_provider_name,
  DROP COLUMN IF EXISTS creditor_name,
  DROP COLUMN IF EXISTS program_name;

ALTER TABLE public.imaging_orders
  DROP COLUMN IF EXISTS insurance_provider_name,
  DROP COLUMN IF EXISTS creditor_name,
  DROP COLUMN IF EXISTS program_name;

ALTER TABLE public.billing_items
  DROP COLUMN IF EXISTS insurance_provider_name,
  DROP COLUMN IF EXISTS creditor_name,
  DROP COLUMN IF EXISTS program_name;

ALTER TABLE public.payment_line_items
  DROP COLUMN IF EXISTS creditor_name,
  DROP COLUMN IF EXISTS program_name;

COMMIT;
