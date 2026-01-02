-- Add lab, imaging, and pharmacy user roles to the user_role enum
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'lab_technician';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'imaging_technician';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'radiologist';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'pharmacist';