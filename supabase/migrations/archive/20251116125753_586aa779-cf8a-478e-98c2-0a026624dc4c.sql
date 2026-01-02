-- Drop the auto-progression trigger that automatically updates visit status on consultation payment
-- This is replaced with manual button-driven progression by the cashier

DROP TRIGGER IF EXISTS auto_update_visit_status_on_consultation_payment ON payment_line_items;
DROP FUNCTION IF EXISTS update_visit_status_on_consultation_payment();

-- The auto_add_consultation_fee trigger remains to create billing items
-- but it will NOT auto-progress the patient journey anymore