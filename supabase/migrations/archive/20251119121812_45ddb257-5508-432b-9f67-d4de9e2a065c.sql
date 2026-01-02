-- Fix departments RLS policy to include clinic-admin role

-- Drop the policies I just added (they conflict with existing RBAC policy)
DROP POLICY IF EXISTS "Clinic admins can insert departments" ON public.departments;
DROP POLICY IF EXISTS "Clinic admins can update departments" ON public.departments;
DROP POLICY IF EXISTS "Clinic admins can delete departments" ON public.departments;
DROP POLICY IF EXISTS "Users can view departments in their facility" ON public.departments;

-- Drop and recreate the RBAC policy with clinic-admin included
DROP POLICY IF EXISTS "RBAC: Admins can manage departments" ON public.departments;

CREATE POLICY "RBAC: Admins can manage departments"
  ON public.departments
  FOR ALL
  USING (
    (
      current_user_has_any_role(ARRAY['admin', 'clinic-admin', 'super_admin', 'hospital_ceo', 'medical_director', 'nursing_head'])
      OR can_manage_master_data()
    )
    AND (tenant_id = get_user_tenant_id())
    AND (facility_id IN (SELECT unnest(get_user_facility_ids())))
  )
  WITH CHECK (
    (
      current_user_has_any_role(ARRAY['admin', 'clinic-admin', 'super_admin', 'hospital_ceo', 'medical_director', 'nursing_head'])
      OR can_manage_master_data()
    )
    AND (tenant_id = get_user_tenant_id())
    AND (facility_id IN (SELECT unnest(get_user_facility_ids())))
  );