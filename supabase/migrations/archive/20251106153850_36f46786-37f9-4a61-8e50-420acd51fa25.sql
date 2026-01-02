-- Comprehensive Facility-Based Data Isolation for Staff
-- This ensures staff can ONLY see data from their own facility

-- ==============================================
-- VISITS TABLE - Core facility isolation
-- ==============================================
DROP POLICY IF EXISTS "Staff can view visits from their facility" ON visits;
DROP POLICY IF EXISTS "Staff can create visits for their facility" ON visits;
DROP POLICY IF EXISTS "Staff can update visits from their facility" ON visits;
DROP POLICY IF EXISTS "Allow patient viewing for authenticated users" ON visits;
DROP POLICY IF EXISTS "Users can create visits" ON visits;
DROP POLICY IF EXISTS "Users can update visits they created" ON visits;

CREATE POLICY "Staff can view visits from their facility"
ON visits FOR SELECT
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
  OR public.is_super_admin()
);

CREATE POLICY "Staff can create visits for their facility"
ON visits FOR INSERT
TO authenticated
WITH CHECK (
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Staff can update visits from their facility"
ON visits FOR UPDATE
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
);

-- ==============================================
-- LAB ORDERS - Must reference visits
-- ==============================================
DROP POLICY IF EXISTS "Medical staff can manage lab orders" ON lab_orders;
DROP POLICY IF EXISTS "Finance can view lab orders for payment" ON lab_orders;
DROP POLICY IF EXISTS "Finance staff can view lab orders for payment" ON lab_orders;
DROP POLICY IF EXISTS "Finance staff can update lab payment status" ON lab_orders;
DROP POLICY IF EXISTS "Nursing head can view all lab orders" ON lab_orders;

CREATE POLICY "Staff can view lab orders from their facility"
ON lab_orders FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM visits v
    WHERE v.id = lab_orders.visit_id
    AND v.facility_id = public.get_user_facility_id()
  )
  OR public.is_super_admin()
);

CREATE POLICY "Medical staff can create lab orders for their facility"
ON lab_orders FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM visits v
    WHERE v.id = lab_orders.visit_id
    AND v.facility_id = public.get_user_facility_id()
  )
);

CREATE POLICY "Medical staff can update lab orders from their facility"
ON lab_orders FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM visits v
    WHERE v.id = lab_orders.visit_id
    AND v.facility_id = public.get_user_facility_id()
  )
);

-- ==============================================
-- IMAGING ORDERS - Must reference visits
-- ==============================================
DROP POLICY IF EXISTS "Medical staff can manage imaging orders" ON imaging_orders;
DROP POLICY IF EXISTS "Finance can view imaging orders for payment" ON imaging_orders;
DROP POLICY IF EXISTS "Finance staff can view imaging orders for payment" ON imaging_orders;
DROP POLICY IF EXISTS "Finance staff can update imaging payment status" ON imaging_orders;
DROP POLICY IF EXISTS "Nursing head can view all imaging orders" ON imaging_orders;

CREATE POLICY "Staff can view imaging orders from their facility"
ON imaging_orders FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM visits v
    WHERE v.id = imaging_orders.visit_id
    AND v.facility_id = public.get_user_facility_id()
  )
  OR public.is_super_admin()
);

CREATE POLICY "Medical staff can create imaging orders for their facility"
ON imaging_orders FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM visits v
    WHERE v.id = imaging_orders.visit_id
    AND v.facility_id = public.get_user_facility_id()
  )
);

CREATE POLICY "Medical staff can update imaging orders from their facility"
ON imaging_orders FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM visits v
    WHERE v.id = imaging_orders.visit_id
    AND v.facility_id = public.get_user_facility_id()
  )
);

-- ==============================================
-- PEDIATRIC, SURGICAL, EMERGENCY ASSESSMENTS
-- ==============================================
DROP POLICY IF EXISTS "Facility staff can view pediatric assessments" ON pediatric_assessments;
DROP POLICY IF EXISTS "Nurses and doctors can create pediatric assessments" ON pediatric_assessments;
DROP POLICY IF EXISTS "Nurses and doctors can update pediatric assessments" ON pediatric_assessments;

CREATE POLICY "Staff can view pediatric assessments from their facility"
ON pediatric_assessments FOR SELECT
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
  OR public.is_super_admin()
);

CREATE POLICY "Clinical staff can create pediatric assessments for their facility"
ON pediatric_assessments FOR INSERT
TO authenticated
WITH CHECK (
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update pediatric assessments from their facility"
ON pediatric_assessments FOR UPDATE
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
);

-- Surgical assessments
DROP POLICY IF EXISTS "Facility staff can view surgical assessments" ON surgical_assessments;
DROP POLICY IF EXISTS "Doctors can create surgical assessments" ON surgical_assessments;
DROP POLICY IF EXISTS "Doctors can update surgical assessments" ON surgical_assessments;

CREATE POLICY "Staff can view surgical assessments from their facility"
ON surgical_assessments FOR SELECT
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
  OR public.is_super_admin()
);

CREATE POLICY "Clinical staff can create surgical assessments for their facility"
ON surgical_assessments FOR INSERT
TO authenticated
WITH CHECK (
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update surgical assessments from their facility"
ON surgical_assessments FOR UPDATE
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
);

-- Emergency assessments
DROP POLICY IF EXISTS "Facility staff can view emergency assessments" ON emergency_assessments;
DROP POLICY IF EXISTS "Clinical staff can create emergency assessments" ON emergency_assessments;
DROP POLICY IF EXISTS "Clinical staff can update emergency assessments" ON emergency_assessments;

CREATE POLICY "Staff can view emergency assessments from their facility"
ON emergency_assessments FOR SELECT
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
  OR public.is_super_admin()
);

CREATE POLICY "Clinical staff can create emergency assessments for their facility"
ON emergency_assessments FOR INSERT
TO authenticated
WITH CHECK (
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update emergency assessments from their facility"
ON emergency_assessments FOR UPDATE
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
);

-- ==============================================
-- IMMUNIZATION RECORDS
-- ==============================================
DROP POLICY IF EXISTS "Facility staff can view immunization records" ON immunization_records;
DROP POLICY IF EXISTS "Nurses can create immunization records" ON immunization_records;
DROP POLICY IF EXISTS "Nurses can update immunization records" ON immunization_records;

CREATE POLICY "Staff can view immunization records from their facility"
ON immunization_records FOR SELECT
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
  OR public.is_super_admin()
);

CREATE POLICY "Nurses can create immunization records for their facility"
ON immunization_records FOR INSERT
TO authenticated
WITH CHECK (
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Nurses can update immunization records from their facility"
ON immunization_records FOR UPDATE
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
);

-- ==============================================
-- ANC ASSESSMENTS (not visits)
-- ==============================================
DROP POLICY IF EXISTS "Facility staff can view ANC assessments" ON anc_assessments;
DROP POLICY IF EXISTS "Nurses can create ANC assessments" ON anc_assessments;
DROP POLICY IF EXISTS "Nurses can update ANC assessments" ON anc_assessments;

CREATE POLICY "Staff can view ANC assessments from their facility"
ON anc_assessments FOR SELECT
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
  OR public.is_super_admin()
);

CREATE POLICY "Clinical staff can create ANC assessments for their facility"
ON anc_assessments FOR INSERT
TO authenticated
WITH CHECK (
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update ANC assessments from their facility"
ON anc_assessments FOR UPDATE
TO authenticated
USING (
  facility_id = public.get_user_facility_id()
);

-- Add documentation comments
COMMENT ON POLICY "Staff can view visits from their facility" ON visits IS 
'Critical security policy: Ensures staff can only view visits from their own facility. Super admins bypass this restriction.';

COMMENT ON POLICY "Staff can view lab orders from their facility" ON lab_orders IS 
'Critical security policy: Ensures staff can only view lab orders for visits in their facility through JOIN validation.';