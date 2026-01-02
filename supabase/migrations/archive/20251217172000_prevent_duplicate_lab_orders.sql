-- Remove duplicate lab orders keeping the earliest record per visit/test pair
WITH ordered AS (
  SELECT
    ctid,
    visit_id,
    lower(trim(test_name)) AS normalized_name,
    ROW_NUMBER() OVER (PARTITION BY visit_id, lower(trim(test_name)) ORDER BY created_at NULLS FIRST, id) AS rn
  FROM public.lab_orders
)
DELETE FROM public.lab_orders l
USING ordered o
WHERE l.ctid = o.ctid
  AND o.rn > 1;

-- Enforce uniqueness of lab tests per visit (case-insensitive)
DROP INDEX IF EXISTS idx_unique_visit_test;
CREATE UNIQUE INDEX idx_unique_visit_test ON public.lab_orders (visit_id, lower(trim(test_name)));
