-- Drop restrictive policy and create a proper one for clinic admins
DROP POLICY IF EXISTS "Clinic admins can manage their facility services" ON public.medical_services;

-- Create a policy that allows admins and clinic-admins to manage services for their facility
CREATE POLICY "Clinic admins can manage their facility services" 
ON public.medical_services 
FOR ALL 
USING (
  current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'hospital_ceo'::text, 'medical_director'::text])
  AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  AND tenant_id = get_user_tenant_id()
)
WITH CHECK (
  current_user_has_any_role(ARRAY['admin'::text, 'clinic-admin'::text, 'hospital_ceo'::text, 'medical_director'::text])
  AND facility_id IN (SELECT unnest(get_user_facility_ids()))
  AND tenant_id = get_user_tenant_id()
);