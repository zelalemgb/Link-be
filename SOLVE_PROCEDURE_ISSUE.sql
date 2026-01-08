-- ==========================================
-- MANUAL FIX FOR PROCEDURE LOOKUP & RLS
-- Run this in your Supabase Dashboard SQL Editor
-- ==========================================

-- 1. Enable RLS on medical_services (safety)
ALTER TABLE public.medical_services ENABLE ROW LEVEL SECURITY;

-- 2. Allow ALL staff (Doctors, Nurses, Cashiers) to view medical services
-- This fixes the "Procedure Lookup Failed" error (RLS)
DROP POLICY IF EXISTS "Staff can view medical services" ON public.medical_services;
CREATE POLICY "Staff can view medical services"
ON public.medical_services
FOR SELECT
USING (
  facility_id = public.get_user_facility_id()
  OR is_super_admin()
);

-- Allow admins/medical directors to manage them (optional but good)
DROP POLICY IF EXISTS "Admins can manage medical services" ON public.medical_services;
CREATE POLICY "Admins can manage medical services"
ON public.medical_services
FOR ALL
USING (
  (
    EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('hospital_ceo', 'medical_director', 'finance', 'system_admin')
    )
    AND
    facility_id = public.get_user_facility_id()
  )
  OR is_super_admin()
);

-- 3. Fix Data Mismatch ("Procedure" vs "Procedures")
-- The code expects 'Procedures' (plural), but data might be 'Procedure' (singular).
-- This fixes the "Procedure Not Found" error.
UPDATE public.medical_services
SET category = 'Procedures'
WHERE category = 'Procedure'
  AND facility_id = public.get_user_facility_id();

-- verify correct update
SELECT id, name, category FROM public.medical_services WHERE category = 'Procedures';
