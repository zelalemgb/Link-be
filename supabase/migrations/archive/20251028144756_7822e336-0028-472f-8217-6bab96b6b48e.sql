-- Drop and recreate the current_stock view without security definer
DROP VIEW IF EXISTS public.current_stock;

CREATE OR REPLACE VIEW public.current_stock 
WITH (security_invoker = true)
AS
SELECT 
  i.id as inventory_item_id,
  i.name,
  i.generic_name,
  i.dosage_form,
  i.strength,
  i.unit_of_measure,
  i.reorder_level,
  i.facility_id,
  COALESCE(
    (SELECT SUM(
      CASE 
        WHEN movement_type IN ('receipt', 'transfer_in', 'adjustment') THEN quantity
        WHEN movement_type IN ('issue', 'transfer_out', 'expired', 'damaged') THEN -quantity
        ELSE 0
      END
    )
    FROM stock_movements sm
    WHERE sm.inventory_item_id = i.id AND sm.facility_id = i.facility_id
    ), 0
  ) as current_quantity,
  (SELECT MAX(created_at) FROM stock_movements sm WHERE sm.inventory_item_id = i.id) as last_movement_date
FROM inventory_items i
WHERE i.is_active = true;