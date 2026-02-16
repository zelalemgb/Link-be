\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Reset schemas for repeatability
DROP TABLE IF EXISTS public.patient_documents CASCADE;
DROP TABLE IF EXISTS public.patient_accounts CASCADE;
DROP TABLE IF EXISTS public.stock_movements CASCADE;
DROP TABLE IF EXISTS public.inventory_items CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.tenants CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;

CREATE SCHEMA auth;

-- Helper functions mirroring production behavior
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((NULLIF(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid, gen_random_uuid());
$$;

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE public.facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id)
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  facility_id uuid REFERENCES public.facilities(id),
  user_role text NOT NULL
);

CREATE OR REPLACE FUNCTION public.get_user_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_user_facility_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(user_role = 'super_admin', false)
  FROM public.users
  WHERE auth_user_id = auth.uid()
  LIMIT 1;
$$;

CREATE TABLE public.inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id uuid NOT NULL REFERENCES public.facilities(id),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  created_by uuid NOT NULL REFERENCES public.users(id)
);

CREATE TABLE public.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id),
  facility_id uuid NOT NULL REFERENCES public.facilities(id),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  created_by uuid NOT NULL REFERENCES public.users(id),
  movement_type text NOT NULL,
  quantity integer NOT NULL
);

CREATE TABLE public.patient_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id)
);

CREATE TABLE public.patient_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_account_id uuid NOT NULL REFERENCES public.patient_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  file_url text NOT NULL
);

-- Enable RLS
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_documents ENABLE ROW LEVEL SECURITY;

-- Inventory RLS policies
CREATE POLICY "Facility staff can view stock movements" ON public.stock_movements
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (facility_id = get_user_facility_id() OR is_super_admin())
  );

CREATE POLICY "Logistic officers manage stock movements" ON public.stock_movements
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

-- Patient portal RLS policies
CREATE POLICY "Patients can view their own account" ON public.patient_accounts
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
  );

CREATE POLICY "Patients can update their own account" ON public.patient_accounts
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
  );

CREATE POLICY "Patients can create account" ON public.patient_accounts
  FOR INSERT WITH CHECK (tenant_id = get_user_tenant_id());

CREATE POLICY "Patients can view their own documents" ON public.patient_documents
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

CREATE POLICY "Patients can insert their own documents" ON public.patient_documents
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND patient_account_id IN (
      SELECT id FROM public.patient_accounts
      WHERE phone_number = (current_setting('request.jwt.claims', true)::json ->> 'phone')
        AND tenant_id = get_user_tenant_id()
    )
  );

-- Seed data
INSERT INTO public.tenants (id, name) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Tenant A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Tenant B');

INSERT INTO public.facilities (id, tenant_id) VALUES
  ('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.users (auth_user_id, tenant_id, facility_id, user_role) VALUES
  ('aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'logistic_officer'),
  ('bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', 'logistic_officer'),
  ('cccccccc-0000-0000-0000-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, 'patient'),
  ('dddddddd-0000-0000-0000-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NULL, 'patient');

INSERT INTO public.inventory_items (id, facility_id, tenant_id, created_by) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000001', 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', (SELECT id FROM public.users WHERE auth_user_id = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa')),
  ('bbbbbbbb-bbbb-bbbb-bbbb-000000000002', 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', (SELECT id FROM public.users WHERE auth_user_id = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb'));

INSERT INTO public.stock_movements (id, inventory_item_id, facility_id, tenant_id, created_by, movement_type, quantity) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001', 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', (SELECT id FROM public.users WHERE auth_user_id = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'), 'receipt', 10),
  ('bbbbbbbb-bbbb-bbbb-bbbb-000000000022', 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002', 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', (SELECT id FROM public.users WHERE auth_user_id = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb'), 'receipt', 5);

INSERT INTO public.patient_accounts (id, phone_number, tenant_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000101', '+11111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-000000000202', '+22222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.patient_documents (id, patient_account_id, tenant_id, file_url) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000001001', 'aaaaaaaa-aaaa-aaaa-aaaa-000000000101', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'https://tenant-a/doc1.pdf'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-000000002002', 'bbbbbbbb-bbbb-bbbb-bbbb-000000000202', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'https://tenant-b/doc2.pdf');

-- Prepare authenticated role
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

SET ROLE authenticated;

-- Staff access within tenant should succeed
SELECT set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa')::text, false);

DO $$
DECLARE
  accessible boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.stock_movements WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000011'
  ) INTO accessible;
  IF NOT accessible THEN
    RAISE EXCEPTION 'Expected tenant-scoped staff to access their stock movement';
  END IF;
END
$$;

-- Cross-tenant staff access must be denied
SELECT set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb')::text, false);

DO $$
DECLARE
  accessible boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.stock_movements WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000011'
  ) INTO accessible;
  IF accessible THEN
    RAISE EXCEPTION 'Cross-tenant staff access to stock_movements should be blocked';
  END IF;
END
$$;

-- Patient access within tenant
SELECT set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-cccccccccccc', 'phone', '+11111111111')::text, false);

DO $$
DECLARE
  accessible boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.patient_documents WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000001001'
  ) INTO accessible;
  IF NOT accessible THEN
    RAISE EXCEPTION 'Expected patient to access their own document';
  END IF;
END
$$;

-- Patient cross-tenant access denied
SELECT set_config('request.jwt.claims', json_build_object('sub', 'dddddddd-0000-0000-0000-dddddddddddd', 'phone', '+22222222222')::text, false);

DO $$
DECLARE
  accessible boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.patient_documents WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000001001'
  ) INTO accessible;
  IF accessible THEN
    RAISE EXCEPTION 'Cross-tenant patient access to documents should be blocked';
  END IF;
END
$$;

RESET ROLE;
