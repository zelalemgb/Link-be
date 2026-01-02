-- Allow finance/cashier staff to view medication orders for payment processing
CREATE POLICY "Finance staff can view medication orders for payment"
ON medication_orders
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
);

-- Allow finance/cashier staff to update payment status on medication orders
CREATE POLICY "Finance staff can update medication payment status"
ON medication_orders
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
);

-- Allow finance/cashier staff to view lab orders for payment processing
CREATE POLICY "Finance staff can view lab orders for payment"
ON lab_orders
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
);

-- Allow finance/cashier staff to update payment status on lab orders
CREATE POLICY "Finance staff can update lab payment status"
ON lab_orders
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
);

-- Allow finance/cashier staff to view imaging orders for payment processing
CREATE POLICY "Finance staff can view imaging orders for payment"
ON imaging_orders
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
);

-- Allow finance/cashier staff to update payment status on imaging orders
CREATE POLICY "Finance staff can update imaging payment status"
ON imaging_orders
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM users
    WHERE users.auth_user_id = auth.uid()
    AND users.user_role = 'finance'
  )
);