-- Enforce non-negative monetary/quantity values and arithmetic relationships
-- across finance and inventory tables.

BEGIN;

-- Finance data clean-up ----------------------------------------------------
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

-- Inventory data clean-up --------------------------------------------------
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

-- Finance constraints ------------------------------------------------------
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_total_amount_non_negative,
  DROP CONSTRAINT IF EXISTS payments_amount_paid_non_negative,
  DROP CONSTRAINT IF EXISTS payments_amount_due_non_negative,
  DROP CONSTRAINT IF EXISTS payments_amount_consistency;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_total_amount_non_negative CHECK (total_amount >= 0),
  ADD CONSTRAINT payments_amount_paid_non_negative CHECK (amount_paid >= 0),
  ADD CONSTRAINT payments_amount_due_non_negative CHECK (amount_due >= 0),
  ADD CONSTRAINT payments_amount_consistency CHECK (
    amount_paid <= total_amount
    AND amount_due = GREATEST(total_amount - amount_paid, 0)
  );

ALTER TABLE public.payment_line_items
  DROP CONSTRAINT IF EXISTS payment_line_items_unit_price_non_negative,
  DROP CONSTRAINT IF EXISTS payment_line_items_quantity_non_negative,
  DROP CONSTRAINT IF EXISTS payment_line_items_subtotal_non_negative,
  DROP CONSTRAINT IF EXISTS payment_line_items_final_amount_non_negative,
  DROP CONSTRAINT IF EXISTS payment_line_items_discount_bounds,
  DROP CONSTRAINT IF EXISTS payment_line_items_subtotal_calculation,
  DROP CONSTRAINT IF EXISTS payment_line_items_final_amount_calculation;

ALTER TABLE public.payment_line_items
  ADD CONSTRAINT payment_line_items_unit_price_non_negative CHECK (unit_price >= 0),
  ADD CONSTRAINT payment_line_items_quantity_non_negative CHECK (quantity >= 0),
  ADD CONSTRAINT payment_line_items_subtotal_non_negative CHECK (subtotal >= 0),
  ADD CONSTRAINT payment_line_items_final_amount_non_negative CHECK (final_amount >= 0),
  ADD CONSTRAINT payment_line_items_discount_bounds CHECK (
    COALESCE(discount_amount, 0) BETWEEN 0 AND subtotal
  ),
  ADD CONSTRAINT payment_line_items_subtotal_calculation CHECK (
    subtotal = (unit_price * quantity)::NUMERIC(10,2)
  ),
  ADD CONSTRAINT payment_line_items_final_amount_calculation CHECK (
    final_amount = subtotal - COALESCE(discount_amount, 0)
  );

ALTER TABLE public.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_amount_non_negative;

ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_amount_non_negative CHECK (amount >= 0);

-- Inventory constraints ----------------------------------------------------
ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_unit_cost_non_negative;

ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_unit_cost_non_negative CHECK (unit_cost IS NULL OR unit_cost >= 0);

ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_quantity_non_negative,
  DROP CONSTRAINT IF EXISTS stock_movements_balance_after_non_negative,
  DROP CONSTRAINT IF EXISTS stock_movements_unit_cost_non_negative,
  DROP CONSTRAINT IF EXISTS stock_movements_total_cost_non_negative,
  DROP CONSTRAINT IF EXISTS stock_movements_total_cost_calculation;

ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_quantity_non_negative CHECK (quantity >= 0),
  ADD CONSTRAINT stock_movements_balance_after_non_negative CHECK (balance_after >= 0),
  ADD CONSTRAINT stock_movements_unit_cost_non_negative CHECK (unit_cost IS NULL OR unit_cost >= 0),
  ADD CONSTRAINT stock_movements_total_cost_non_negative CHECK (total_cost IS NULL OR total_cost >= 0),
  ADD CONSTRAINT stock_movements_total_cost_calculation CHECK (
    total_cost IS NULL
    OR (unit_cost IS NOT NULL AND total_cost = (unit_cost * quantity)::NUMERIC(10,2))
  );

COMMIT;
