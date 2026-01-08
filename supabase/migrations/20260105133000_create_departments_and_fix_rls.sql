-- Create departments table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.departments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  facility_id UUID REFERENCES public.facilities(id),
  tenant_id UUID REFERENCES public.tenants(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- Create RLS Policies for departments
-- Allow all authenticated users to view active departments
DROP POLICY IF EXISTS "Authenticated users can view active departments" ON public.departments;
CREATE POLICY "Authenticated users can view active departments"
ON public.departments
FOR SELECT
TO authenticated
USING (is_active = true);

-- Allow admins to manage departments (insert/update/delete)
DROP POLICY IF EXISTS "Clinic admins can manage departments" ON public.departments;
CREATE POLICY "Clinic admins can manage departments"
ON public.departments
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.users
    LEFT JOIN public.user_roles ON users.id = user_roles.user_id AND user_roles.is_active = true
    LEFT JOIN public.roles ON user_roles.role_id = roles.id
    WHERE users.auth_user_id = auth.uid()
    AND (users.user_role IN ('admin', 'super_admin') OR roles.slug = 'clinic-admin')
  )
);

-- Seed default departments for ALL facilities
DO $$
DECLARE
  target_tenant_id UUID;
  d_info RECORD;
BEGIN
  -- 1. Get a valid tenant_id to use as fallback
  SELECT id INTO target_tenant_id FROM public.tenants WHERE id = '00000000-0000-0000-0000-000000000001';
  IF target_tenant_id IS NULL THEN
    SELECT id INTO target_tenant_id FROM public.tenants LIMIT 1;
  END IF;

  -- 2. Insert departments for EACH facility
  IF target_tenant_id IS NOT NULL THEN
    -- Iterate over our list of default departments with their types and code prefixes
    FOR d_info IN SELECT * FROM (VALUES 
      ('General OPD', 'outpatient', 'OPD'),
      ('Emergency', 'emergency', 'EMR'),
      ('Pediatric', 'pediatric', 'PED'),
      ('ANC', 'maternity', 'ANC'),
      ('Labor & Delivery', 'maternity', 'LND'),
      ('Family Planning', 'outpatient', 'FP'),
      ('EPI', 'outpatient', 'EPI'),
      ('Dental', 'outpatient', 'DNT'),
      ('Eye', 'outpatient', 'OPT'),
      ('Imaging', 'outpatient', 'IMG'),
      ('Laboratory', 'outpatient', 'LAB')
    ) AS t(name, type, code_prefix)
    LOOP
      
      -- Insert for every facility found in the 'facilities' table
      INSERT INTO public.departments (name, facility_id, tenant_id, is_active, department_type, code)
      SELECT 
        d_info.name, 
        f.id, 
        target_tenant_id, 
        true,
        d_info.type,
        -- Generate a semi-unique code: PREFIX + Random 4 chars. 
        -- Using md5 of facility_id + name to make it deterministic per facility but unique.
        d_info.code_prefix || '-' || UPPER(SUBSTRING(MD5(f.id::text || d_info.name), 1, 4))
      FROM public.facilities f
      WHERE NOT EXISTS (
        SELECT 1 FROM public.departments existing 
        WHERE existing.name = d_info.name 
        AND existing.facility_id = f.id
      );
      
    END LOOP;
  ELSE
    RAISE NOTICE 'No tenant found, skipping department seeding';
  END IF;
END;
$$;


-- Fix RLS for Users table to allow seeing other staff (for "Assign to Clinician")
DROP POLICY IF EXISTS "Authenticated users can view all staff" ON public.users;
CREATE POLICY "Authenticated users can view all staff"
ON public.users
FOR SELECT
TO authenticated
USING (true);


-- CRITICAL FIX: Allow all authenticated users (staff) to UPDATE visits
DROP POLICY IF EXISTS "Authenticated users can update visits" ON public.visits;
CREATE POLICY "Authenticated users can update visits"
ON public.visits
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);
