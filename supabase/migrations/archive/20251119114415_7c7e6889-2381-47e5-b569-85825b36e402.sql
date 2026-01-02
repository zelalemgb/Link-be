-- Add RLS policies for departments table to allow clinic admins to manage master data

-- Drop existing policies if any
DROP POLICY IF EXISTS "Clinic admins can insert departments" ON public.departments;
DROP POLICY IF EXISTS "Clinic admins can update departments" ON public.departments;
DROP POLICY IF EXISTS "Clinic admins can delete departments" ON public.departments;
DROP POLICY IF EXISTS "Users can view departments in their facility" ON public.departments;

-- Enable RLS on departments table (already enabled, but safe to run)
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view departments in their facility
CREATE POLICY "Users can view departments in their facility"
  ON public.departments
  FOR SELECT
  USING (
    facility_id IN (SELECT unnest(public.get_user_facility_ids()))
    OR public.is_super_admin()
  );

-- Policy: Clinic admins can insert departments
CREATE POLICY "Clinic admins can insert departments"
  ON public.departments
  FOR INSERT
  WITH CHECK (
    public.can_manage_master_data()
    AND facility_id IN (SELECT unnest(public.get_user_facility_ids()))
  );

-- Policy: Clinic admins can update departments
CREATE POLICY "Clinic admins can update departments"
  ON public.departments
  FOR UPDATE
  USING (
    public.can_manage_master_data()
    AND facility_id IN (SELECT unnest(public.get_user_facility_ids()))
  )
  WITH CHECK (
    public.can_manage_master_data()
    AND facility_id IN (SELECT unnest(public.get_user_facility_ids()))
  );

-- Policy: Clinic admins can delete departments
CREATE POLICY "Clinic admins can delete departments"
  ON public.departments
  FOR DELETE
  USING (
    public.can_manage_master_data()
    AND facility_id IN (SELECT unnest(public.get_user_facility_ids()))
  );