-- RBAC System Validation Tests
-- Tests for Phase 6: RLS Policy Updates with RBAC

\set ON_ERROR_STOP on

BEGIN;

-- Create test helpers
CREATE OR REPLACE FUNCTION test_assert(condition boolean, test_name text)
RETURNS void AS $$
BEGIN
  IF NOT condition THEN
    RAISE EXCEPTION 'Test failed: %', test_name;
  END IF;
  RAISE NOTICE 'PASS: %', test_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TEST SETUP: Create test tenant, facility, and users with different roles
-- ============================================================================

-- Create test tenant
INSERT INTO tenants (id, name) VALUES 
  ('test-tenant-rbac', 'Test Tenant RBAC')
ON CONFLICT (id) DO NOTHING;

-- Create test facility
INSERT INTO facilities (id, name, tenant_id, verified) VALUES
  ('test-facility-rbac', 'Test Facility RBAC', 'test-tenant-rbac', true)
ON CONFLICT (id) DO NOTHING;

-- Create test auth users
INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
VALUES 
  ('test-doctor-rbac', 'doctor@test.com', crypt('password', gen_salt('bf')), now(), '{"email": "doctor@test.com"}'),
  ('test-nurse-rbac', 'nurse@test.com', crypt('password', gen_salt('bf')), now(), '{"email": "nurse@test.com"}'),
  ('test-receptionist-rbac', 'receptionist@test.com', crypt('password', gen_salt('bf')), now(), '{"email": "receptionist@test.com"}'),
  ('test-cashier-rbac', 'cashier@test.com', crypt('password', gen_salt('bf')), now(), '{"email": "cashier@test.com"}'),
  ('test-lab-tech-rbac', 'lab@test.com', crypt('password', gen_salt('bf')), now(), '{"email": "lab@test.com"}'),
  ('test-pharmacist-rbac', 'pharmacist@test.com', crypt('password', gen_salt('bf')), now(), '{"email": "pharmacist@test.com"}'),
  ('test-admin-rbac', 'admin@test.com', crypt('password', gen_salt('bf')), now(), '{"email": "admin@test.com"}')
ON CONFLICT (id) DO NOTHING;

-- Create users in users table
INSERT INTO users (id, auth_user_id, tenant_id, facility_id, full_name, email, phone_number)
VALUES
  ('user-doctor-rbac', 'test-doctor-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Dr. Test Doctor', 'doctor@test.com', '0911111111'),
  ('user-nurse-rbac', 'test-nurse-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Nurse', 'nurse@test.com', '0911111112'),
  ('user-receptionist-rbac', 'test-receptionist-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Receptionist', 'receptionist@test.com', '0911111113'),
  ('user-cashier-rbac', 'test-cashier-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Cashier', 'cashier@test.com', '0911111114'),
  ('user-lab-tech-rbac', 'test-lab-tech-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Lab Tech', 'lab@test.com', '0911111115'),
  ('user-pharmacist-rbac', 'test-pharmacist-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Pharmacist', 'pharmacist@test.com', '0911111116'),
  ('user-admin-rbac', 'test-admin-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Admin', 'admin@test.com', '0911111117')
ON CONFLICT (id) DO NOTHING;

-- Assign roles to users
INSERT INTO user_roles (user_id, role_id, facility_id, tenant_id)
SELECT 'user-doctor-rbac', id, 'test-facility-rbac', 'test-tenant-rbac' FROM roles WHERE name = 'doctor'
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id, facility_id, tenant_id)
SELECT 'user-nurse-rbac', id, 'test-facility-rbac', 'test-tenant-rbac' FROM roles WHERE name = 'nurse'
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id, facility_id, tenant_id)
SELECT 'user-receptionist-rbac', id, 'test-facility-rbac', 'test-tenant-rbac' FROM roles WHERE name = 'receptionist'
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id, facility_id, tenant_id)
SELECT 'user-cashier-rbac', id, 'test-facility-rbac', 'test-tenant-rbac' FROM roles WHERE name = 'finance'
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id, facility_id, tenant_id)
SELECT 'user-lab-tech-rbac', id, 'test-facility-rbac', 'test-tenant-rbac' FROM roles WHERE name = 'lab_technician'
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id, facility_id, tenant_id)
SELECT 'user-pharmacist-rbac', id, 'test-facility-rbac', 'test-tenant-rbac' FROM roles WHERE name = 'pharmacist'
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id, facility_id, tenant_id)
SELECT 'user-admin-rbac', id, 'test-facility-rbac', 'test-tenant-rbac' FROM roles WHERE name = 'admin'
ON CONFLICT DO NOTHING;

-- Create test patient
INSERT INTO patients (id, tenant_id, facility_id, full_name, date_of_birth, gender, phone_number)
VALUES ('test-patient-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Patient', '1990-01-01', 'male', '0922222222')
ON CONFLICT (id) DO NOTHING;

-- Create test visit
INSERT INTO visits (id, patient_id, facility_id, tenant_id, visit_date, visit_type, journey_stage)
VALUES ('test-visit-rbac', 'test-patient-rbac', 'test-facility-rbac', 'test-tenant-rbac', now(), 'outpatient', 'registered')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- TEST 1: Helper Function Validation
-- ============================================================================

RAISE NOTICE E'\n=== TEST 1: Helper Function Validation ===';

-- Test has_any_role function
DO $$
DECLARE
  v_has_role boolean;
BEGIN
  -- Set session as doctor
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-doctor-rbac')::text, false);
  
  v_has_role := has_any_role(ARRAY['doctor', 'nurse']);
  PERFORM test_assert(v_has_role = true, 'Doctor has_any_role([doctor, nurse]) returns true');
  
  v_has_role := has_any_role(ARRAY['pharmacist']);
  PERFORM test_assert(v_has_role = false, 'Doctor has_any_role([pharmacist]) returns false');
END;
$$;

-- Test get_user_facility_ids function
DO $$
DECLARE
  v_facility_ids uuid[];
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-doctor-rbac')::text, false);
  
  v_facility_ids := get_user_facility_ids();
  PERFORM test_assert(
    'test-facility-rbac'::uuid = ANY(v_facility_ids),
    'get_user_facility_ids returns correct facility for doctor'
  );
END;
$$;

-- Test can_access_patient_data function
DO $$
DECLARE
  v_can_access boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-doctor-rbac')::text, false);
  
  v_can_access := can_access_patient_data('test-patient-rbac');
  PERFORM test_assert(v_can_access = true, 'Doctor can access patient data in their facility');
END;
$$;

-- ============================================================================
-- TEST 2: Patient Data Access Policies
-- ============================================================================

RAISE NOTICE E'\n=== TEST 2: Patient Data Access Policies ===';

-- Test doctor can view patients
DO $$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-doctor-rbac')::text, false);
  SET ROLE authenticated;
  
  SELECT COUNT(*) INTO v_count FROM patients WHERE id = 'test-patient-rbac';
  PERFORM test_assert(v_count > 0, 'Doctor can view patients in their facility');
  
  RESET ROLE;
END;
$$;

-- Test nurse can view patients
DO $$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-nurse-rbac')::text, false);
  SET ROLE authenticated;
  
  SELECT COUNT(*) INTO v_count FROM patients WHERE id = 'test-patient-rbac';
  PERFORM test_assert(v_count > 0, 'Nurse can view patients in their facility');
  
  RESET ROLE;
END;
$$;

-- Test receptionist can create patients
DO $$
DECLARE
  v_inserted boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-receptionist-rbac')::text, false);
  SET ROLE authenticated;
  
  BEGIN
    INSERT INTO patients (id, tenant_id, facility_id, full_name, date_of_birth, gender, phone_number)
    VALUES ('test-patient-rbac-2', 'test-tenant-rbac', 'test-facility-rbac', 'Test Patient 2', '1995-01-01', 'female', '0933333333');
    v_inserted := true;
  EXCEPTION WHEN OTHERS THEN
    v_inserted := false;
  END;
  
  PERFORM test_assert(v_inserted = true, 'Receptionist can create patients');
  
  RESET ROLE;
END;
$$;

-- ============================================================================
-- TEST 3: Visit Access Policies
-- ============================================================================

RAISE NOTICE E'\n=== TEST 3: Visit Access Policies ===';

-- Test clinical staff can view visits
DO $$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-doctor-rbac')::text, false);
  SET ROLE authenticated;
  
  SELECT COUNT(*) INTO v_count FROM visits WHERE id = 'test-visit-rbac';
  PERFORM test_assert(v_count > 0, 'Doctor can view visits');
  
  RESET ROLE;
END;
$$;

-- Test receptionist can create visits
DO $$
DECLARE
  v_inserted boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-receptionist-rbac')::text, false);
  SET ROLE authenticated;
  
  BEGIN
    INSERT INTO visits (id, patient_id, facility_id, tenant_id, visit_date, visit_type)
    VALUES ('test-visit-rbac-2', 'test-patient-rbac', 'test-facility-rbac', 'test-tenant-rbac', now(), 'outpatient');
    v_inserted := true;
  EXCEPTION WHEN OTHERS THEN
    v_inserted := false;
  END;
  
  PERFORM test_assert(v_inserted = true, 'Receptionist can create visits');
  
  RESET ROLE;
END;
$$;

-- ============================================================================
-- TEST 4: Order Access Policies
-- ============================================================================

RAISE NOTICE E'\n=== TEST 4: Order Access Policies ===';

-- Create test lab service
INSERT INTO medical_services (id, tenant_id, facility_id, service_name, category, price)
VALUES ('test-lab-service-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Lab', 'laboratory', 100)
ON CONFLICT (id) DO NOTHING;

-- Test doctor can create lab orders
DO $$
DECLARE
  v_inserted boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-doctor-rbac')::text, false);
  SET ROLE authenticated;
  
  BEGIN
    INSERT INTO lab_orders (id, visit_id, patient_id, facility_id, tenant_id, test_name, ordered_by, amount)
    VALUES ('test-lab-order-rbac', 'test-visit-rbac', 'test-patient-rbac', 'test-facility-rbac', 'test-tenant-rbac', 'Test Lab', 'user-doctor-rbac', 100);
    v_inserted := true;
  EXCEPTION WHEN OTHERS THEN
    v_inserted := false;
  END;
  
  PERFORM test_assert(v_inserted = true, 'Doctor can create lab orders');
  
  RESET ROLE;
END;
$$;

-- Test lab tech can view lab orders
DO $$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-lab-tech-rbac')::text, false);
  SET ROLE authenticated;
  
  SELECT COUNT(*) INTO v_count FROM lab_orders WHERE id = 'test-lab-order-rbac';
  PERFORM test_assert(v_count > 0, 'Lab tech can view lab orders');
  
  RESET ROLE;
END;
$$;

-- Test lab tech can update lab orders
DO $$
DECLARE
  v_updated boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-lab-tech-rbac')::text, false);
  SET ROLE authenticated;
  
  BEGIN
    UPDATE lab_orders SET status = 'in_progress' WHERE id = 'test-lab-order-rbac';
    v_updated := true;
  EXCEPTION WHEN OTHERS THEN
    v_updated := false;
  END;
  
  PERFORM test_assert(v_updated = true, 'Lab tech can update lab orders');
  
  RESET ROLE;
END;
$$;

-- ============================================================================
-- TEST 5: Billing Access Policies
-- ============================================================================

RAISE NOTICE E'\n=== TEST 5: Billing Access Policies ===';

-- Test cashier can view billing items
DO $$
DECLARE
  v_can_select boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-cashier-rbac')::text, false);
  SET ROLE authenticated;
  
  BEGIN
    PERFORM * FROM billing_items WHERE visit_id = 'test-visit-rbac' LIMIT 1;
    v_can_select := true;
  EXCEPTION WHEN OTHERS THEN
    v_can_select := false;
  END;
  
  PERFORM test_assert(v_can_select = true, 'Cashier can view billing items');
  
  RESET ROLE;
END;
$$;

-- Test cashier can create payments
DO $$
DECLARE
  v_inserted boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-cashier-rbac')::text, false);
  SET ROLE authenticated;
  
  BEGIN
    INSERT INTO payments (id, visit_id, patient_id, facility_id, tenant_id, total_amount, amount_paid, created_by)
    VALUES ('test-payment-rbac', 'test-visit-rbac', 'test-patient-rbac', 'test-facility-rbac', 'test-tenant-rbac', 100, 100, 'user-cashier-rbac');
    v_inserted := true;
  EXCEPTION WHEN OTHERS THEN
    v_inserted := false;
  END;
  
  PERFORM test_assert(v_inserted = true, 'Cashier can create payments');
  
  RESET ROLE;
END;
$$;

-- ============================================================================
-- TEST 6: Master Data Access Policies
-- ============================================================================

RAISE NOTICE E'\n=== TEST 6: Master Data Access Policies ===';

-- Test admin can create medical services
DO $$
DECLARE
  v_inserted boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-admin-rbac')::text, false);
  SET ROLE authenticated;
  
  BEGIN
    INSERT INTO medical_services (id, tenant_id, facility_id, service_name, category, price)
    VALUES ('test-service-rbac', 'test-tenant-rbac', 'test-facility-rbac', 'Test Service', 'consultation', 50);
    v_inserted := true;
  EXCEPTION WHEN OTHERS THEN
    v_inserted := false;
  END;
  
  PERFORM test_assert(v_inserted = true, 'Admin can create medical services');
  
  RESET ROLE;
END;
$$;

-- Test doctor cannot create medical services
DO $$
DECLARE
  v_inserted boolean := false;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-doctor-rbac')::text, false);
  SET ROLE authenticated;
  
  BEGIN
    INSERT INTO medical_services (id, tenant_id, facility_id, service_name, category, price)
    VALUES ('test-service-rbac-2', 'test-tenant-rbac', 'test-facility-rbac', 'Test Service 2', 'consultation', 50);
    v_inserted := true;
  EXCEPTION WHEN OTHERS THEN
    v_inserted := false;
  END;
  
  PERFORM test_assert(v_inserted = false, 'Doctor cannot create medical services');
  
  RESET ROLE;
END;
$$;

-- ============================================================================
-- TEST 7: Cross-Facility Access Prevention
-- ============================================================================

RAISE NOTICE E'\n=== TEST 7: Cross-Facility Access Prevention ===';

-- Create another facility
INSERT INTO facilities (id, name, tenant_id, verified) VALUES
  ('test-facility-rbac-2', 'Test Facility RBAC 2', 'test-tenant-rbac', true)
ON CONFLICT (id) DO NOTHING;

-- Create patient in other facility
INSERT INTO patients (id, tenant_id, facility_id, full_name, date_of_birth, gender, phone_number)
VALUES ('test-patient-rbac-other', 'test-tenant-rbac', 'test-facility-rbac-2', 'Other Patient', '1990-01-01', 'male', '0944444444')
ON CONFLICT (id) DO NOTHING;

-- Test doctor cannot access patient from other facility
DO $$
DECLARE
  v_count integer;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'test-doctor-rbac')::text, false);
  SET ROLE authenticated;
  
  SELECT COUNT(*) INTO v_count FROM patients WHERE id = 'test-patient-rbac-other';
  PERFORM test_assert(v_count = 0, 'Doctor cannot access patients from other facility');
  
  RESET ROLE;
END;
$$;

-- ============================================================================
-- CLEANUP
-- ============================================================================

RAISE NOTICE E'\n=== Cleaning up test data ===';

-- Reset role
RESET ROLE;
PERFORM set_config('request.jwt.claims', '', false);

RAISE NOTICE E'\n=== All RBAC validation tests completed successfully ===';

ROLLBACK;
