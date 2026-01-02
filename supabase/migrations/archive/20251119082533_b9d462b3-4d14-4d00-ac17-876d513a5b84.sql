-- Phase 6.2c: Update RLS policies for billing tables to use RBAC

-- ============================================================================
-- PAYMENTS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Finance staff can view payments" ON public.payments;
DROP POLICY IF EXISTS "Cashiers can create payments" ON public.payments;
DROP POLICY IF EXISTS "Cashiers can update payments" ON public.payments;
DROP POLICY IF EXISTS "Cashiers can view payments at their facility" ON public.payments;
DROP POLICY IF EXISTS "Super admins can manage all payments" ON public.payments;
DROP POLICY IF EXISTS "Finance can view all payments" ON public.payments;
DROP POLICY IF EXISTS "Admins can manage payments" ON public.payments;

-- Create new RBAC-based policies for payments
CREATE POLICY "RBAC: Users with billing view permission can view payments"
  ON public.payments
  FOR SELECT
  USING (
    can_view_billing() 
    AND tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

CREATE POLICY "RBAC: Users with billing create permission can create payments"
  ON public.payments
  FOR INSERT
  WITH CHECK (
    current_user_has_any_role(ARRAY['cashier', 'finance', 'finance_officer', 'admin', 'super_admin'])
    AND tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

CREATE POLICY "RBAC: Users with billing update permission can update payments"
  ON public.payments
  FOR UPDATE
  USING (
    current_user_has_any_role(ARRAY['cashier', 'finance', 'finance_officer', 'admin', 'super_admin'])
    AND tenant_id = get_user_tenant_id()
    AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  );

CREATE POLICY "RBAC: Super admins can delete payments"
  ON public.payments
  FOR DELETE
  USING (is_super_admin());

-- ============================================================================
-- PAYMENT_LINE_ITEMS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Finance staff can view payment line items" ON public.payment_line_items;
DROP POLICY IF EXISTS "Cashiers can create payment line items" ON public.payment_line_items;
DROP POLICY IF EXISTS "Cashiers can update payment line items" ON public.payment_line_items;
DROP POLICY IF EXISTS "Super admins can manage payment line items" ON public.payment_line_items;
DROP POLICY IF EXISTS "Admins can manage payment line items" ON public.payment_line_items;

-- Create new RBAC-based policies for payment_line_items
CREATE POLICY "RBAC: Users with billing view permission can view line items"
  ON public.payment_line_items
  FOR SELECT
  USING (
    can_view_billing()
    AND payment_id IN (
      SELECT id FROM public.payments 
      WHERE tenant_id = get_user_tenant_id()
      AND facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Users with billing create permission can create line items"
  ON public.payment_line_items
  FOR INSERT
  WITH CHECK (
    current_user_has_any_role(ARRAY['cashier', 'finance', 'finance_officer', 'admin', 'super_admin'])
    AND payment_id IN (
      SELECT id FROM public.payments 
      WHERE tenant_id = get_user_tenant_id()
      AND facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Users with billing update permission can update line items"
  ON public.payment_line_items
  FOR UPDATE
  USING (
    current_user_has_any_role(ARRAY['cashier', 'finance', 'finance_officer', 'admin', 'super_admin'])
    AND payment_id IN (
      SELECT id FROM public.payments 
      WHERE tenant_id = get_user_tenant_id()
      AND facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Super admins can delete line items"
  ON public.payment_line_items
  FOR DELETE
  USING (is_super_admin());

-- ============================================================================
-- PAYMENT_TRANSACTIONS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Finance staff can view payment transactions" ON public.payment_transactions;
DROP POLICY IF EXISTS "Cashiers can create payment transactions" ON public.payment_transactions;
DROP POLICY IF EXISTS "Cashiers can update payment transactions" ON public.payment_transactions;
DROP POLICY IF EXISTS "Super admins can manage payment transactions" ON public.payment_transactions;
DROP POLICY IF EXISTS "Admins can manage payment transactions" ON public.payment_transactions;

-- Create new RBAC-based policies for payment_transactions
CREATE POLICY "RBAC: Users with billing view permission can view transactions"
  ON public.payment_transactions
  FOR SELECT
  USING (
    can_view_billing()
    AND tenant_id = get_user_tenant_id()
    AND payment_id IN (
      SELECT id FROM public.payments 
      WHERE facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Users with billing create permission can create transactions"
  ON public.payment_transactions
  FOR INSERT
  WITH CHECK (
    current_user_has_any_role(ARRAY['cashier', 'finance', 'finance_officer', 'admin', 'super_admin'])
    AND tenant_id = get_user_tenant_id()
    AND payment_id IN (
      SELECT id FROM public.payments 
      WHERE facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Users with billing update permission can update transactions"
  ON public.payment_transactions
  FOR UPDATE
  USING (
    current_user_has_any_role(ARRAY['cashier', 'finance', 'finance_officer', 'admin', 'super_admin'])
    AND tenant_id = get_user_tenant_id()
    AND payment_id IN (
      SELECT id FROM public.payments 
      WHERE facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Super admins can delete transactions"
  ON public.payment_transactions
  FOR DELETE
  USING (is_super_admin());

-- ============================================================================
-- BILLING_ITEMS TABLE
-- ============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Authenticated users can manage billing" ON public.billing_items;
DROP POLICY IF EXISTS "Finance can view all billing" ON public.billing_items;
DROP POLICY IF EXISTS "Super admins can manage all billing" ON public.billing_items;
DROP POLICY IF EXISTS "Staff can view billing items at their facility" ON public.billing_items;
DROP POLICY IF EXISTS "Staff can create billing items" ON public.billing_items;
DROP POLICY IF EXISTS "Staff can update billing items" ON public.billing_items;

-- Create new RBAC-based policies for billing_items
CREATE POLICY "RBAC: Users with billing view permission can view billing items"
  ON public.billing_items
  FOR SELECT
  USING (
    can_view_billing()
    AND tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT v.id FROM public.visits v
      WHERE v.facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Staff can create billing items"
  ON public.billing_items
  FOR INSERT
  WITH CHECK (
    current_user_has_any_role(ARRAY['receptionist', 'cashier', 'nurse', 'doctor', 'clinical_officer', 'finance', 'finance_officer', 'admin', 'super_admin'])
    AND tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT v.id FROM public.visits v
      WHERE v.facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Staff can update billing items"
  ON public.billing_items
  FOR UPDATE
  USING (
    current_user_has_any_role(ARRAY['receptionist', 'cashier', 'nurse', 'doctor', 'clinical_officer', 'finance', 'finance_officer', 'admin', 'super_admin'])
    AND tenant_id = get_user_tenant_id()
    AND visit_id IN (
      SELECT v.id FROM public.visits v
      WHERE v.facility_id IN (SELECT unnest(get_user_facility_ids()))
    )
  );

CREATE POLICY "RBAC: Super admins can delete billing items"
  ON public.billing_items
  FOR DELETE
  USING (is_super_admin());