-- Phase 6.2a Part 2: Update RLS policies for clinical tables to use RBAC system

-- ============================================================================
-- ADMISSIONS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view admissions at their facility" ON public.admissions;
DROP POLICY IF EXISTS "Clinical staff can create admissions" ON public.admissions;
DROP POLICY IF EXISTS "Clinical staff can update admissions" ON public.admissions;
DROP POLICY IF EXISTS "Super admins can manage all admissions" ON public.admissions;

CREATE POLICY "Users can view admissions at their facility"
ON public.admissions FOR SELECT
USING (
  public.is_super_admin() OR
  (public.can_access_patient_data() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create admissions"
ON public.admissions FOR INSERT
WITH CHECK (
  public.can_manage_admissions() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update admissions"
ON public.admissions FOR UPDATE
USING (
  public.can_manage_admissions() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- ANC ASSESSMENTS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view ANC assessments at their facility" ON public.anc_assessments;
DROP POLICY IF EXISTS "Clinical staff can create ANC assessments" ON public.anc_assessments;
DROP POLICY IF EXISTS "Clinical staff can update ANC assessments" ON public.anc_assessments;

CREATE POLICY "Users can view ANC assessments"
ON public.anc_assessments FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create ANC assessments"
ON public.anc_assessments FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update ANC assessments"
ON public.anc_assessments FOR UPDATE
USING (
  public.is_clinical_staff() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- EMERGENCY ASSESSMENTS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view emergency assessments at their facility" ON public.emergency_assessments;
DROP POLICY IF EXISTS "Clinical staff can create emergency assessments" ON public.emergency_assessments;
DROP POLICY IF EXISTS "Clinical staff can update emergency assessments" ON public.emergency_assessments;

CREATE POLICY "Users can view emergency assessments"
ON public.emergency_assessments FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create emergency assessments"
ON public.emergency_assessments FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update emergency assessments"
ON public.emergency_assessments FOR UPDATE
USING (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- DELIVERY RECORDS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view delivery records at their facility" ON public.delivery_records;
DROP POLICY IF EXISTS "Clinical staff can create delivery records" ON public.delivery_records;
DROP POLICY IF EXISTS "Clinical staff can update delivery records" ON public.delivery_records;

CREATE POLICY "Users can view delivery records"
ON public.delivery_records FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create delivery records"
ON public.delivery_records FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update delivery records"
ON public.delivery_records FOR UPDATE
USING (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- FAMILY PLANNING VISITS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view family planning visits at their facility" ON public.family_planning_visits;
DROP POLICY IF EXISTS "Clinical staff can create family planning visits" ON public.family_planning_visits;
DROP POLICY IF EXISTS "Clinical staff can update family planning visits" ON public.family_planning_visits;

CREATE POLICY "Users can view family planning visits"
ON public.family_planning_visits FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create family planning visits"
ON public.family_planning_visits FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update family planning visits"
ON public.family_planning_visits FOR UPDATE
USING (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- IMMUNIZATION RECORDS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view immunization records at their facility" ON public.immunization_records;
DROP POLICY IF EXISTS "Clinical staff can create immunization records" ON public.immunization_records;
DROP POLICY IF EXISTS "Clinical staff can update immunization records" ON public.immunization_records;

CREATE POLICY "Users can view immunization records"
ON public.immunization_records FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create immunization records"
ON public.immunization_records FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update immunization records"
ON public.immunization_records FOR UPDATE
USING (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- PEDIATRIC ASSESSMENTS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view pediatric assessments at their facility" ON public.pediatric_assessments;
DROP POLICY IF EXISTS "Clinical staff can create pediatric assessments" ON public.pediatric_assessments;
DROP POLICY IF EXISTS "Clinical staff can update pediatric assessments" ON public.pediatric_assessments;

CREATE POLICY "Users can view pediatric assessments"
ON public.pediatric_assessments FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create pediatric assessments"
ON public.pediatric_assessments FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update pediatric assessments"
ON public.pediatric_assessments FOR UPDATE
USING (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- SURGICAL ASSESSMENTS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view surgical assessments at their facility" ON public.surgical_assessments;
DROP POLICY IF EXISTS "Clinical staff can create surgical assessments" ON public.surgical_assessments;
DROP POLICY IF EXISTS "Clinical staff can update surgical assessments" ON public.surgical_assessments;

CREATE POLICY "Users can view surgical assessments"
ON public.surgical_assessments FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND facility_id = public.get_user_facility_id())
);

CREATE POLICY "Clinical staff can create surgical assessments"
ON public.surgical_assessments FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

CREATE POLICY "Clinical staff can update surgical assessments"
ON public.surgical_assessments FOR UPDATE
USING (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id() AND
  facility_id = public.get_user_facility_id()
);

-- ============================================================================
-- CARE PLAN INTERVENTIONS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view care plan interventions at their facility" ON public.care_plan_interventions;
DROP POLICY IF EXISTS "Clinical staff can create care plan interventions" ON public.care_plan_interventions;
DROP POLICY IF EXISTS "Clinical staff can update care plan interventions" ON public.care_plan_interventions;

CREATE POLICY "Users can view care plan interventions"
ON public.care_plan_interventions FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND tenant_id = public.get_user_tenant_id())
);

CREATE POLICY "Clinical staff can create care plan interventions"
ON public.care_plan_interventions FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id()
);

CREATE POLICY "Clinical staff can update care plan interventions"
ON public.care_plan_interventions FOR UPDATE
USING (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id()
);

-- ============================================================================
-- NURSING CARE PLANS TABLE
-- ============================================================================
DROP POLICY IF EXISTS "Users can view nursing care plans at their facility" ON public.nursing_care_plans;
DROP POLICY IF EXISTS "Clinical staff can create nursing care plans" ON public.nursing_care_plans;
DROP POLICY IF EXISTS "Clinical staff can update nursing care plans" ON public.nursing_care_plans;

CREATE POLICY "Users can view nursing care plans"
ON public.nursing_care_plans FOR SELECT
USING (
  public.is_super_admin() OR
  (public.is_clinical_staff() AND tenant_id = public.get_user_tenant_id())
);

CREATE POLICY "Clinical staff can create nursing care plans"
ON public.nursing_care_plans FOR INSERT
WITH CHECK (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id()
);

CREATE POLICY "Clinical staff can update nursing care plans"
ON public.nursing_care_plans FOR UPDATE
USING (
  public.is_clinical_staff() AND
  tenant_id = public.get_user_tenant_id()
);