-- Prevent deletion of paid lab orders
-- Drop existing delete policies if any
DO $$ 
BEGIN
  DROP POLICY IF EXISTS "Prevent deletion of paid lab orders" ON lab_orders;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

-- Create policy to prevent deletion of paid orders
CREATE POLICY "Prevent deletion of paid lab orders"
ON lab_orders
FOR DELETE
USING (
  payment_status = 'unpaid' 
  AND paid_at IS NULL
);