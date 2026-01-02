-- Add tenant_id columns and backfill for remaining inventory tables
ALTER TABLE public.inventory_accounts ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.dispensing_units ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.request_for_resupply ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.request_line_items ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.issue_orders ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.issue_order_items ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Backfill tenant_id for inventory tables using facility relationships
UPDATE public.inventory_accounts ia
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE ia.facility_id = f.id
  AND ia.tenant_id IS DISTINCT FROM f.tenant_id;

UPDATE public.dispensing_units du
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE du.facility_id = f.id
  AND du.tenant_id IS DISTINCT FROM f.tenant_id;

UPDATE public.request_for_resupply rfr
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE rfr.facility_id = f.id
  AND rfr.tenant_id IS DISTINCT FROM f.tenant_id;

UPDATE public.issue_orders io
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE io.facility_id = f.id
  AND io.tenant_id IS DISTINCT FROM f.tenant_id;

UPDATE public.stock_movements sm
SET tenant_id = COALESCE(f.tenant_id, ii.tenant_id)
FROM public.inventory_items ii
LEFT JOIN public.facilities f ON f.id = sm.facility_id
WHERE sm.inventory_item_id = ii.id
  AND (sm.tenant_id IS DISTINCT FROM COALESCE(f.tenant_id, ii.tenant_id));

UPDATE public.request_line_items rli
SET tenant_id = rfr.tenant_id
FROM public.request_for_resupply rfr
WHERE rli.request_id = rfr.id
  AND rli.tenant_id IS DISTINCT FROM rfr.tenant_id;

UPDATE public.issue_order_items ioi
SET tenant_id = io.tenant_id
FROM public.issue_orders io
WHERE ioi.order_id = io.id
  AND ioi.tenant_id IS DISTINCT FROM io.tenant_id;

-- Default any remaining null tenant_ids to the platform default tenant
UPDATE public.inventory_accounts
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.dispensing_units
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.request_for_resupply
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.issue_orders
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.stock_movements
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.request_line_items
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.issue_order_items
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

-- Enforce not-null and foreign key constraints
ALTER TABLE public.inventory_accounts
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.inventory_accounts
  DROP CONSTRAINT IF EXISTS inventory_accounts_tenant_id_fkey;
ALTER TABLE public.inventory_accounts
  ADD CONSTRAINT inventory_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.dispensing_units
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.dispensing_units
  DROP CONSTRAINT IF EXISTS dispensing_units_tenant_id_fkey;
ALTER TABLE public.dispensing_units
  ADD CONSTRAINT dispensing_units_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.request_for_resupply
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.request_for_resupply
  DROP CONSTRAINT IF EXISTS request_for_resupply_tenant_id_fkey;
ALTER TABLE public.request_for_resupply
  ADD CONSTRAINT request_for_resupply_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.issue_orders
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.issue_orders
  DROP CONSTRAINT IF EXISTS issue_orders_tenant_id_fkey;
ALTER TABLE public.issue_orders
  ADD CONSTRAINT issue_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.stock_movements
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_tenant_id_fkey;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.request_line_items
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.request_line_items
  DROP CONSTRAINT IF EXISTS request_line_items_tenant_id_fkey;
ALTER TABLE public.request_line_items
  ADD CONSTRAINT request_line_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.issue_order_items
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.issue_order_items
  DROP CONSTRAINT IF EXISTS issue_order_items_tenant_id_fkey;
ALTER TABLE public.issue_order_items
  ADD CONSTRAINT issue_order_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

-- Ensure indexes exist for new tenant columns
CREATE INDEX IF NOT EXISTS idx_inventory_accounts_tenant_id ON public.inventory_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispensing_units_tenant_id ON public.dispensing_units(tenant_id);
CREATE INDEX IF NOT EXISTS idx_request_for_resupply_tenant_id ON public.request_for_resupply(tenant_id);
CREATE INDEX IF NOT EXISTS idx_issue_orders_tenant_id ON public.issue_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_id ON public.stock_movements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_request_line_items_tenant_id ON public.request_line_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_issue_order_items_tenant_id ON public.issue_order_items(tenant_id);

-- Update patient portal tenant assignments using patient relationships
ALTER TABLE public.patient_accounts ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE public.patient_accounts pa
SET tenant_id = sub.tenant_id
FROM (
  SELECT pa.id, MIN(p.tenant_id) AS tenant_id
  FROM public.patient_accounts pa
  JOIN public.patients p ON p.patient_account_id = pa.id
  GROUP BY pa.id
) sub
WHERE pa.id = sub.id
  AND (pa.tenant_id IS NULL OR pa.tenant_id = '00000000-0000-0000-0000-000000000001');

UPDATE public.patient_accounts
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

ALTER TABLE public.patient_accounts
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.patient_accounts
  DROP CONSTRAINT IF EXISTS patient_accounts_tenant_id_fkey;
ALTER TABLE public.patient_accounts
  ADD CONSTRAINT patient_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.patient_documents ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.patient_visit_summaries ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.patient_symptom_logs ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE public.patient_appointment_requests ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE public.patient_documents pd
SET tenant_id = pa.tenant_id
FROM public.patient_accounts pa
WHERE pd.patient_account_id = pa.id
  AND pd.tenant_id IS DISTINCT FROM pa.tenant_id;

UPDATE public.patient_visit_summaries pvs
SET tenant_id = pa.tenant_id
FROM public.patient_accounts pa
WHERE pvs.patient_account_id = pa.id
  AND pvs.tenant_id IS DISTINCT FROM pa.tenant_id;

UPDATE public.patient_symptom_logs psl
SET tenant_id = pa.tenant_id
FROM public.patient_accounts pa
WHERE psl.patient_account_id = pa.id
  AND psl.tenant_id IS DISTINCT FROM pa.tenant_id;

UPDATE public.patient_appointment_requests par
SET tenant_id = pa.tenant_id
FROM public.patient_accounts pa
WHERE par.patient_account_id = pa.id
  AND par.tenant_id IS DISTINCT FROM pa.tenant_id;

UPDATE public.patient_documents
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.patient_visit_summaries
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.patient_symptom_logs
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

UPDATE public.patient_appointment_requests
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE tenant_id IS NULL;

ALTER TABLE public.patient_documents
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.patient_documents
  DROP CONSTRAINT IF EXISTS patient_documents_tenant_id_fkey;
ALTER TABLE public.patient_documents
  ADD CONSTRAINT patient_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.patient_visit_summaries
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.patient_visit_summaries
  DROP CONSTRAINT IF EXISTS patient_visit_summaries_tenant_id_fkey;
ALTER TABLE public.patient_visit_summaries
  ADD CONSTRAINT patient_visit_summaries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.patient_symptom_logs
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.patient_symptom_logs
  DROP CONSTRAINT IF EXISTS patient_symptom_logs_tenant_id_fkey;
ALTER TABLE public.patient_symptom_logs
  ADD CONSTRAINT patient_symptom_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

ALTER TABLE public.patient_appointment_requests
  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.patient_appointment_requests
  DROP CONSTRAINT IF EXISTS patient_appointment_requests_tenant_id_fkey;
ALTER TABLE public.patient_appointment_requests
  ADD CONSTRAINT patient_appointment_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_patient_documents_tenant_id ON public.patient_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_visit_summaries_tenant_id ON public.patient_visit_summaries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_symptom_logs_tenant_id ON public.patient_symptom_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_appointment_requests_tenant_id ON public.patient_appointment_requests(tenant_id);

-- Update RLS policies to enforce tenant scoping
DROP POLICY IF EXISTS "Facility staff can view their accounts" ON public.inventory_accounts;
CREATE POLICY "Facility staff can view their accounts" ON public.inventory_accounts
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers can manage accounts" ON public.inventory_accounts;
CREATE POLICY "Logistic officers can manage accounts" ON public.inventory_accounts
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Facility staff can view their units" ON public.dispensing_units;
CREATE POLICY "Facility staff can view their units" ON public.dispensing_units
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers can manage units" ON public.dispensing_units;
CREATE POLICY "Logistic officers can manage units" ON public.dispensing_units
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Facility staff can view their requests" ON public.request_for_resupply;
CREATE POLICY "Facility staff can view their requests" ON public.request_for_resupply
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers can create and edit requests" ON public.request_for_resupply;
CREATE POLICY "Logistic officers can create and edit requests" ON public.request_for_resupply
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Users can view request line items" ON public.request_line_items;
CREATE POLICY "Users can view request line items" ON public.request_line_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.request_for_resupply rfr
      WHERE rfr.id = request_line_items.request_id
        AND rfr.tenant_id = get_user_tenant_id()
        AND (rfr.facility_id = get_user_facility_id() OR is_super_admin())
    )
  );

DROP POLICY IF EXISTS "Users can manage request line items" ON public.request_line_items;
CREATE POLICY "Users can manage request line items" ON public.request_line_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.request_for_resupply rfr
      WHERE rfr.id = request_line_items.request_id
        AND rfr.tenant_id = get_user_tenant_id()
        AND rfr.facility_id = get_user_facility_id()
        AND EXISTS (
          SELECT 1 FROM public.users
          WHERE auth_user_id = auth.uid()
          AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
        )
    )
  );

DROP POLICY IF EXISTS "Facility staff can view their issue orders" ON public.issue_orders;
CREATE POLICY "Facility staff can view their issue orders" ON public.issue_orders
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers can manage issue orders" ON public.issue_orders;
CREATE POLICY "Logistic officers can manage issue orders" ON public.issue_orders
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Users can view issue order items" ON public.issue_order_items;
CREATE POLICY "Users can view issue order items" ON public.issue_order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.issue_orders io
      WHERE io.id = issue_order_items.order_id
        AND io.tenant_id = get_user_tenant_id()
        AND (io.facility_id = get_user_facility_id() OR is_super_admin())
    )
  );

DROP POLICY IF EXISTS "Users can manage issue order items" ON public.issue_order_items;
CREATE POLICY "Users can manage issue order items" ON public.issue_order_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.issue_orders io
      WHERE io.id = issue_order_items.order_id
        AND io.tenant_id = get_user_tenant_id()
        AND io.facility_id = get_user_facility_id()
        AND EXISTS (
          SELECT 1 FROM public.users
          WHERE auth_user_id = auth.uid()
          AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
        )
    )
  );

DROP POLICY IF EXISTS "Facility staff can view their receiving invoices" ON public.receiving_invoices;
CREATE POLICY "Facility staff can view their receiving invoices" ON public.receiving_invoices
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers can manage receiving invoices" ON public.receiving_invoices;
CREATE POLICY "Logistic officers can manage receiving invoices" ON public.receiving_invoices
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Users can view receiving invoice items" ON public.receiving_invoice_items;
CREATE POLICY "Users can view receiving invoice items" ON public.receiving_invoice_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.receiving_invoices ri
      WHERE ri.id = receiving_invoice_items.invoice_id
        AND ri.tenant_id = get_user_tenant_id()
        AND (ri.facility_id = get_user_facility_id() OR is_super_admin())
    )
  );

DROP POLICY IF EXISTS "Users can manage receiving invoice items" ON public.receiving_invoice_items;
CREATE POLICY "Users can manage receiving invoice items" ON public.receiving_invoice_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.receiving_invoices ri
      WHERE ri.id = receiving_invoice_items.invoice_id
        AND ri.tenant_id = get_user_tenant_id()
        AND ri.facility_id = get_user_facility_id()
        AND EXISTS (
          SELECT 1 FROM public.users
          WHERE auth_user_id = auth.uid()
          AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
        )
    )
  );

DROP POLICY IF EXISTS "Facility staff can view their loss adjustments" ON public.loss_adjustments;
CREATE POLICY "Facility staff can view their loss adjustments" ON public.loss_adjustments
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers can create and edit loss adjustments" ON public.loss_adjustments;
CREATE POLICY "Logistic officers can create and edit loss adjustments" ON public.loss_adjustments
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Facility staff can view stock movements" ON public.stock_movements;
CREATE POLICY "Facility staff can view stock movements" ON public.stock_movements
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

DROP POLICY IF EXISTS "Logistic officers and pharmacists can create movements" ON public.stock_movements;
CREATE POLICY "Logistic officers and pharmacists can create movements" ON public.stock_movements
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'super_admin')
    )
  );

DROP POLICY IF EXISTS "Logistic officers can update movements" ON public.stock_movements;
CREATE POLICY "Logistic officers can update movements" ON public.stock_movements
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'super_admin')
    )
  );

-- Patient portal policies with tenant enforcement
DROP POLICY IF EXISTS "Patients can view their own documents" ON public.patient_documents;
CREATE POLICY "Patients can view their own documents" ON public.patient_documents
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can create their own documents" ON public.patient_documents;
CREATE POLICY "Patients can create their own documents" ON public.patient_documents
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can update their own documents" ON public.patient_documents;
CREATE POLICY "Patients can update their own documents" ON public.patient_documents
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can delete their own documents" ON public.patient_documents;
CREATE POLICY "Patients can delete their own documents" ON public.patient_documents
  FOR DELETE USING (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can view their own account" ON public.patient_accounts;
CREATE POLICY "Patients can view their own account" ON public.patient_accounts
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND phone_number = ((current_setting('request.jwt.claims'::text, true))::json ->> 'phone'::text)
  );

DROP POLICY IF EXISTS "Patients can update their own account" ON public.patient_accounts;
CREATE POLICY "Patients can update their own account" ON public.patient_accounts
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND phone_number = ((current_setting('request.jwt.claims'::text, true))::json ->> 'phone'::text)
  );

DROP POLICY IF EXISTS "Patients can view their own visit summaries" ON public.patient_visit_summaries;
CREATE POLICY "Patients can view their own visit summaries" ON public.patient_visit_summaries
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can create manual visit summaries" ON public.patient_visit_summaries;
CREATE POLICY "Patients can create manual visit summaries" ON public.patient_visit_summaries
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
    AND source = 'manual_upload'
  );

DROP POLICY IF EXISTS "System can create link clinic summaries" ON public.patient_visit_summaries;
CREATE POLICY "System can create link clinic summaries" ON public.patient_visit_summaries
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND source = 'link_clinic'
  );

DROP POLICY IF EXISTS "Patients can view their own symptom logs" ON public.patient_symptom_logs;
CREATE POLICY "Patients can view their own symptom logs" ON public.patient_symptom_logs
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can create their own symptom logs" ON public.patient_symptom_logs;
CREATE POLICY "Patients can create their own symptom logs" ON public.patient_symptom_logs
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can view their own appointment requests" ON public.patient_appointment_requests;
CREATE POLICY "Patients can view their own appointment requests" ON public.patient_appointment_requests
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can create appointment requests" ON public.patient_appointment_requests;
CREATE POLICY "Patients can create appointment requests" ON public.patient_appointment_requests
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can update appointment requests" ON public.patient_appointment_requests;
CREATE POLICY "Patients can update appointment requests" ON public.patient_appointment_requests
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

DROP POLICY IF EXISTS "Patients can view their own notifications" ON public.patient_notifications;
CREATE POLICY "Patients can view their own notifications" ON public.patient_notifications
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND patient_id IN (
      SELECT id FROM public.patients
      WHERE patient_account_id IN (
        SELECT id FROM public.patient_accounts
        WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
          AND tenant_id = get_user_tenant_id()
      )
    )
  );

DROP POLICY IF EXISTS "Patients can update their own notifications" ON public.patient_notifications;
CREATE POLICY "Patients can update their own notifications" ON public.patient_notifications
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND patient_id IN (
      SELECT id FROM public.patients
      WHERE patient_account_id IN (
        SELECT id FROM public.patient_accounts
        WHERE phone_number = (current_setting('request.jwt.claims', true)::json->>'phone')
          AND tenant_id = get_user_tenant_id()
      )
    )
  );

DROP POLICY IF EXISTS "Staff can create notifications" ON public.patient_notifications;
CREATE POLICY "Staff can create notifications" ON public.patient_notifications
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
        AND tenant_id = get_user_tenant_id()
    )
  );

-- Ensure staff invitations use tenant scope
DROP POLICY IF EXISTS "Anyone can create patient account" ON public.patient_accounts;
CREATE POLICY "Anyone can create patient account" ON public.patient_accounts
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
  );

