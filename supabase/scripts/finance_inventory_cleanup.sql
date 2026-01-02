-- Cleanup script to normalize monetary and quantity values before applying
-- non-negative/derived value constraints.
BEGIN;

-- Finance ------------------------------------------------------------------
UPDATE public.payments
SET total_amount = GREATEST(total_amount, 0)
WHERE total_amount < 0;

UPDATE public.payments
SET amount_paid = GREATEST(amount_paid, 0)
WHERE amount_paid < 0;

UPDATE public.payments
SET total_amount = amount_paid
WHERE amount_paid > total_amount;

UPDATE public.payments
SET amount_due = GREATEST(total_amount - amount_paid, 0)
WHERE amount_due <> GREATEST(total_amount - amount_paid, 0)
   OR amount_due < 0;

UPDATE public.payment_line_items
SET quantity = ABS(quantity)
WHERE quantity < 0;

UPDATE public.payment_line_items
SET unit_price = ABS(unit_price)
WHERE unit_price < 0;

UPDATE public.payment_line_items
SET subtotal = (unit_price * quantity)::NUMERIC(10,2)
WHERE subtotal IS DISTINCT FROM (unit_price * quantity)::NUMERIC(10,2)
   OR subtotal < 0;

UPDATE public.payment_line_items
SET discount_amount = LEAST(GREATEST(COALESCE(discount_amount, 0), 0), subtotal)
WHERE COALESCE(discount_amount, 0) < 0
   OR COALESCE(discount_amount, 0) > subtotal;

UPDATE public.payment_line_items
SET final_amount = subtotal - COALESCE(discount_amount, 0)
WHERE final_amount IS DISTINCT FROM subtotal - COALESCE(discount_amount, 0)
   OR final_amount < 0;

UPDATE public.payment_transactions
SET amount = ABS(amount)
WHERE amount < 0;

-- Inventory ----------------------------------------------------------------
UPDATE public.inventory_items
SET unit_cost = ABS(unit_cost)
WHERE unit_cost < 0;

UPDATE public.stock_movements
SET quantity = ABS(quantity)
WHERE quantity < 0;

UPDATE public.stock_movements
SET balance_after = GREATEST(balance_after, 0)
WHERE balance_after < 0;

UPDATE public.stock_movements
SET unit_cost = ABS(unit_cost)
WHERE unit_cost < 0;

UPDATE public.stock_movements
SET total_cost = NULL
WHERE unit_cost IS NULL
  AND total_cost IS NOT NULL;

UPDATE public.stock_movements
SET total_cost = (unit_cost * quantity)::NUMERIC(10,2)
WHERE unit_cost IS NOT NULL
  AND total_cost IS DISTINCT FROM (unit_cost * quantity)::NUMERIC(10,2);

UPDATE public.stock_movements
SET total_cost = ABS(total_cost)
WHERE total_cost < 0;

COMMIT;
