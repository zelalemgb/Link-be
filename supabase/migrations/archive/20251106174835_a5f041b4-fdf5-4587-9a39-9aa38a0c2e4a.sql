
-- Create function to automatically deduct stock when medication is dispensed
CREATE OR REPLACE FUNCTION public.auto_deduct_medication_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inventory_item_id uuid;
  v_facility_id uuid;
  v_tenant_id uuid;
  v_current_balance integer;
  v_quantity integer;
  v_user_id uuid;
BEGIN
  -- Only process when status changes to 'dispensed' from a non-dispensed state
  IF NEW.status = 'dispensed' AND (OLD.status IS NULL OR OLD.status != 'dispensed') THEN
    
    -- Get tenant_id from medication order
    v_tenant_id := NEW.tenant_id;
    
    -- Get facility_id from the visit
    SELECT v.facility_id INTO v_facility_id
    FROM visits v
    WHERE v.id = NEW.visit_id;
    
    -- Get user_id from auth context (the pharmacist dispensing)
    SELECT id INTO v_user_id
    FROM users
    WHERE auth_user_id = auth.uid()
    LIMIT 1;
    
    -- Try to find matching inventory item by medication name
    -- Match on exact name first, then try generic name
    SELECT ii.id INTO v_inventory_item_id
    FROM inventory_items ii
    WHERE ii.facility_id = v_facility_id
      AND ii.tenant_id = v_tenant_id
      AND ii.is_active = true
      AND (
        LOWER(ii.name) = LOWER(NEW.medication_name)
        OR LOWER(ii.generic_name) = LOWER(NEW.medication_name)
        OR LOWER(ii.generic_name) = LOWER(NEW.generic_name)
      )
    LIMIT 1;
    
    -- If inventory item found, create stock movement
    IF v_inventory_item_id IS NOT NULL THEN
      
      -- Get current balance from most recent stock movement
      SELECT COALESCE(balance_after, 0) INTO v_current_balance
      FROM stock_movements
      WHERE inventory_item_id = v_inventory_item_id
        AND facility_id = v_facility_id
        AND tenant_id = v_tenant_id
      ORDER BY created_at DESC
      LIMIT 1;
      
      -- Default to 0 if no previous movements
      v_current_balance := COALESCE(v_current_balance, 0);
      
      -- Determine quantity (default to 1 if not specified)
      v_quantity := COALESCE(NEW.quantity, 1);
      
      -- Create stock movement record (negative quantity = stock out)
      INSERT INTO stock_movements (
        tenant_id,
        facility_id,
        inventory_item_id,
        movement_type,
        quantity,
        balance_after,
        patient_id,
        visit_id,
        reference_number,
        notes,
        created_by,
        created_at
      ) VALUES (
        v_tenant_id,
        v_facility_id,
        v_inventory_item_id,
        'out',
        v_quantity,
        v_current_balance - v_quantity,
        NEW.patient_id,
        NEW.visit_id,
        'MED-ORDER-' || NEW.id::text,
        'Auto-deducted: ' || NEW.medication_name || 
          CASE 
            WHEN NEW.dosage IS NOT NULL THEN ' (' || NEW.dosage || ')' 
            ELSE '' 
          END,
        COALESCE(v_user_id, NEW.ordered_by),
        NEW.dispensed_at
      );
      
      RAISE NOTICE 'Stock deducted: % units of % (Item ID: %)', 
        v_quantity, NEW.medication_name, v_inventory_item_id;
      
    ELSE
      RAISE WARNING 'Inventory item not found for medication: % (Generic: %). Stock not deducted.',
        NEW.medication_name, NEW.generic_name;
    END IF;
    
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on medication_orders table
DROP TRIGGER IF EXISTS trigger_auto_deduct_stock ON medication_orders;

CREATE TRIGGER trigger_auto_deduct_stock
  AFTER INSERT OR UPDATE OF status, dispensed_at
  ON medication_orders
  FOR EACH ROW
  EXECUTE FUNCTION auto_deduct_medication_stock();

-- Add documentation
COMMENT ON FUNCTION auto_deduct_medication_stock() IS 
  'Automatically creates tenant-scoped stock_movements record when medication is dispensed. Matches medication to inventory_items by name or generic_name and deducts stock quantity.';

COMMENT ON TRIGGER trigger_auto_deduct_stock ON medication_orders IS
  'Fires after medication status changes to dispensed to automatically deduct stock';
