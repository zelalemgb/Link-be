WITH consult_line_items AS (
  SELECT
    pli.id
  FROM public.payment_line_items pli
  JOIN public.payments pay ON pay.id = pli.payment_id
  LEFT JOIN public.billing_items bi ON bi.id = pli.item_reference_id
  LEFT JOIN public.medical_services ms ON ms.id = bi.service_id
  WHERE pli.item_type = 'service'
    AND (
      pli.item_reference_id = pay.visit_id
      OR (
        bi.id IS NOT NULL
        AND (
          COALESCE(ms.category, '') ILIKE 'consult%'
          OR COALESCE(ms.name, '') ILIKE '%consult%'
        )
      )
    )
)
UPDATE public.payment_line_items AS pli
SET item_type = 'consultation'
FROM consult_line_items cli
WHERE pli.id = cli.id;

-- Recreate visit_payment_status view with resilient consultation detection logic
CREATE OR REPLACE VIEW public.visit_payment_status AS
WITH line_items AS (
  SELECT
    pay.visit_id,
    pli.item_type,
    pli.payment_status,
    pli.final_amount,
    pli.item_reference_id,
    (pli.item_type = 'consultation') AS is_consultation_item,
    (pli.item_type = 'service' AND pli.item_reference_id = pay.visit_id) AS matches_visit_reference,
    EXISTS (
      SELECT 1
      FROM public.billing_items bi
      LEFT JOIN public.medical_services ms ON ms.id = bi.service_id
      WHERE bi.id = pli.item_reference_id
        AND bi.visit_id = pay.visit_id
        AND (
          COALESCE(ms.category, '') ILIKE 'consult%'
          OR COALESCE(ms.name, '') ILIKE '%consult%'
        )
    ) AS matches_catalog_consultation
  FROM public.payments pay
  JOIN public.payment_line_items pli ON pli.payment_id = pay.id
),
line_rollup AS (
  SELECT
    visit_id,
    bool_or(payment_status NOT IN ('paid','waived')) AS has_unpaid_items,
    bool_or(payment_status = 'pending') AS has_pending,
    bool_or(payment_status = 'partial') AS has_partial,
    bool_or(payment_status = 'paid') AS has_paid
  FROM line_items
  GROUP BY visit_id
),
consultation_rollup AS (
  SELECT
    visit_id,
    bool_or(
      (is_consultation_item OR matches_visit_reference OR matches_catalog_consultation)
      AND payment_status IN ('paid','waived')
    ) AS consultation_fee_paid
  FROM line_items
  GROUP BY visit_id
),
payment_activity AS (
  SELECT
    visit_id,
    max(updated_at) AS last_payment_at
  FROM public.payments
  GROUP BY visit_id
)
SELECT
  v.id AS visit_id,
  CASE
    WHEN v.consultation_payment_type IN ('free','insured','credit') THEN 'waived'
    WHEN COALESCE(cr.consultation_fee_paid, false) OR v.fee_paid > 0 THEN 'paid'
    ELSE 'unpaid'
  END AS consultation_payment_status,
  CASE
    WHEN COALESCE(lr.has_unpaid_items, false) THEN 'unpaid'
    WHEN COALESCE(lr.has_partial, false) OR COALESCE(lr.has_pending, false) THEN 'pending'
    WHEN COALESCE(lr.has_paid, false) THEN 'paid'
    ELSE 'none'
  END AS overall_payment_status,
  COALESCE(lr.has_unpaid_items, false) AS has_unpaid_items,
  pa.last_payment_at
FROM public.visits v
LEFT JOIN line_rollup lr ON lr.visit_id = v.id
LEFT JOIN consultation_rollup cr ON cr.visit_id = v.id
LEFT JOIN payment_activity pa ON pa.visit_id = v.id;

GRANT SELECT ON public.visit_payment_status TO authenticated;

-- Refresh downstream materialized view so dashboards pick up the corrected payment flags
REFRESH MATERIALIZED VIEW public.nurse_dashboard_queue;
