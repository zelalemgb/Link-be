-- ============================================================
-- FIX 06 — MAJOR: Replace RLS N+1 Subqueries with STABLE
--                  Helper Functions
-- ============================================================
-- Problem:
--   Many RLS policies contain inline EXISTS subqueries that
--   hit the users table on every row evaluation:
--
--     EXISTS (SELECT 1 FROM public.users
--             WHERE auth_user_id = auth.uid()
--             AND user_role::TEXT IN ('doctor', 'nurse'))
--
--   PostgreSQL evaluates these per-row with no caching, causing
--   N×1 queries for any table scan.  With 500 patients visible
--   on a nurse dashboard, that is 500 extra user-table lookups.
--
-- Fix:
--   Create STABLE SECURITY DEFINER helper functions that are
--   evaluated once per query, cached by the planner, and reused
--   across all RLS policies.
--
--   Existing helpers: get_user_facility_id(), get_user_tenant_id(),
--   is_super_admin()  — already correct.
--
--   New helpers added here:
--     • get_user_role()          → TEXT
--     • is_clinical_staff()      → BOOLEAN  (doctor/clinical_officer/nurse)
--     • is_prescriber()          → BOOLEAN  (doctor/clinical_officer/pharmacist)
--     • is_nurse_or_doctor()     → BOOLEAN  (nurse/doctor/clinical_officer)
--     • is_receptionist()        → BOOLEAN
--     • is_admin_or_super()      → BOOLEAN
--     • is_lab_staff()           → BOOLEAN
--     • is_pharmacy_staff()      → BOOLEAN
-- ============================================================

-- ──────────────────────────────────────────────
-- 1. get_user_role() — returns the calling user's role as TEXT
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_role::TEXT
  FROM public.users
  WHERE auth_user_id = auth.uid()
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_user_role() IS
  'Returns the user_role of the currently authenticated user. '
  'STABLE + SECURITY DEFINER so it is evaluated once per query.';

-- ──────────────────────────────────────────────
-- 2. is_clinical_staff() — doctors, clinical officers, nurses
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_clinical_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
      AND user_role::TEXT IN ('doctor', 'clinical_officer', 'nurse')
  );
$$;

COMMENT ON FUNCTION public.is_clinical_staff() IS
  'TRUE if the current user is a doctor, clinical officer, or nurse.';

-- ──────────────────────────────────────────────
-- 3. is_prescriber() — can write prescriptions / orders
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_prescriber()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
      AND user_role::TEXT IN ('doctor', 'clinical_officer', 'pharmacist')
  );
$$;

COMMENT ON FUNCTION public.is_prescriber() IS
  'TRUE if the current user can create lab/imaging/medication orders.';

-- ──────────────────────────────────────────────
-- 4. is_nurse_or_doctor()
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_nurse_or_doctor()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
      AND user_role::TEXT IN ('doctor', 'clinical_officer', 'nurse')
  );
$$;

COMMENT ON FUNCTION public.is_nurse_or_doctor() IS
  'TRUE if the current user is a nurse, doctor, or clinical officer.';

-- ──────────────────────────────────────────────
-- 5. is_receptionist()
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_receptionist()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
      AND user_role::TEXT = 'receptionist'
  );
$$;

-- ──────────────────────────────────────────────
-- 6. is_admin_or_super()
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin_or_super()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
      AND user_role::TEXT IN ('admin', 'super_admin')
  )
  OR public.is_super_admin();
$$;

-- ──────────────────────────────────────────────
-- 7. is_lab_staff()
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_lab_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
      AND user_role::TEXT IN ('lab_technician', 'lab_scientist', 'doctor', 'clinical_officer')
  );
$$;

-- ──────────────────────────────────────────────
-- 8. is_pharmacy_staff()
-- ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_pharmacy_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid()
      AND user_role::TEXT IN ('pharmacist', 'pharmacy_technician', 'doctor', 'clinical_officer')
  );
$$;

-- ──────────────────────────────────────────────
-- 9. Update RLS policies on anc_assessments to use helpers
--    (demonstrates the pattern — repeat for other tables as needed)
-- ──────────────────────────────────────────────

-- anc_assessments: SELECT
DROP POLICY IF EXISTS "Facility staff can view ANC assessments" ON public.anc_assessments;
CREATE POLICY "Facility staff can view ANC assessments"
  ON public.anc_assessments FOR SELECT
  USING (facility_id = public.get_user_facility_id());

-- anc_assessments: INSERT
DROP POLICY IF EXISTS "Nurses can create ANC assessments" ON public.anc_assessments;
CREATE POLICY "Nurses can create ANC assessments"
  ON public.anc_assessments FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_nurse_or_doctor()
  );

-- anc_assessments: UPDATE
DROP POLICY IF EXISTS "Nurses can update ANC assessments" ON public.anc_assessments;
CREATE POLICY "Nurses can update ANC assessments"
  ON public.anc_assessments FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND public.is_nurse_or_doctor()
  );

-- ──────────────────────────────────────────────
-- emergency_assessments
-- ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Facility staff can view emergency assessments" ON public.emergency_assessments;
CREATE POLICY "Facility staff can view emergency assessments"
  ON public.emergency_assessments FOR SELECT
  USING (facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "Clinical staff can create emergency assessments" ON public.emergency_assessments;
CREATE POLICY "Clinical staff can create emergency assessments"
  ON public.emergency_assessments FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_clinical_staff()
  );

DROP POLICY IF EXISTS "Clinical staff can update emergency assessments" ON public.emergency_assessments;
CREATE POLICY "Clinical staff can update emergency assessments"
  ON public.emergency_assessments FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND public.is_clinical_staff()
  );

-- ──────────────────────────────────────────────
-- immunization_records
-- ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Facility staff can view immunization records" ON public.immunization_records;
CREATE POLICY "Facility staff can view immunization records"
  ON public.immunization_records FOR SELECT
  USING (facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "Nurses can create immunization records" ON public.immunization_records;
CREATE POLICY "Nurses can create immunization records"
  ON public.immunization_records FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_nurse_or_doctor()
  );

DROP POLICY IF EXISTS "Nurses can update immunization records" ON public.immunization_records;
CREATE POLICY "Nurses can update immunization records"
  ON public.immunization_records FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND public.is_nurse_or_doctor()
  );

-- ──────────────────────────────────────────────
-- pediatric_assessments
-- ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Facility staff can view pediatric assessments" ON public.pediatric_assessments;
CREATE POLICY "Facility staff can view pediatric assessments"
  ON public.pediatric_assessments FOR SELECT
  USING (facility_id = public.get_user_facility_id());

DROP POLICY IF EXISTS "Nurses and doctors can create pediatric assessments" ON public.pediatric_assessments;
CREATE POLICY "Nurses and doctors can create pediatric assessments"
  ON public.pediatric_assessments FOR INSERT
  WITH CHECK (
    facility_id = public.get_user_facility_id()
    AND public.is_nurse_or_doctor()
  );

DROP POLICY IF EXISTS "Nurses and doctors can update pediatric assessments" ON public.pediatric_assessments;
CREATE POLICY "Nurses and doctors can update pediatric assessments"
  ON public.pediatric_assessments FOR UPDATE
  USING (
    facility_id = public.get_user_facility_id()
    AND public.is_nurse_or_doctor()
  );

-- ──────────────────────────────────────────────
-- Verification
-- ──────────────────────────────────────────────
SELECT
  routine_name,
  routine_type,
  data_type AS return_type,
  security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'get_user_role', 'is_clinical_staff', 'is_prescriber',
    'is_nurse_or_doctor', 'is_receptionist', 'is_admin_or_super',
    'is_lab_staff', 'is_pharmacy_staff'
  )
ORDER BY routine_name;
