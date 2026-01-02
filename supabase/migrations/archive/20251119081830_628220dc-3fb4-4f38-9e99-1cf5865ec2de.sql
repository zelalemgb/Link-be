-- Phase 6.2a Part 1: Add missing tenant_id columns to clinical assessment tables

-- Add tenant_id to emergency_assessments
ALTER TABLE public.emergency_assessments
ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- Populate tenant_id from facility
UPDATE public.emergency_assessments ea
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE ea.facility_id = f.id
AND ea.tenant_id IS NULL;

-- Make tenant_id NOT NULL and add foreign key
ALTER TABLE public.emergency_assessments
ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.emergency_assessments
ADD CONSTRAINT emergency_assessments_tenant_id_fkey
FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

CREATE INDEX IF NOT EXISTS idx_emergency_assessments_tenant_id 
ON public.emergency_assessments(tenant_id);

-- Add tenant_id to immunization_records
ALTER TABLE public.immunization_records
ADD COLUMN IF NOT EXISTS tenant_id uuid;

UPDATE public.immunization_records ir
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE ir.facility_id = f.id
AND ir.tenant_id IS NULL;

ALTER TABLE public.immunization_records
ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.immunization_records
ADD CONSTRAINT immunization_records_tenant_id_fkey
FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

CREATE INDEX IF NOT EXISTS idx_immunization_records_tenant_id 
ON public.immunization_records(tenant_id);

-- Add tenant_id to pediatric_assessments
ALTER TABLE public.pediatric_assessments
ADD COLUMN IF NOT EXISTS tenant_id uuid;

UPDATE public.pediatric_assessments pa
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE pa.facility_id = f.id
AND pa.tenant_id IS NULL;

ALTER TABLE public.pediatric_assessments
ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.pediatric_assessments
ADD CONSTRAINT pediatric_assessments_tenant_id_fkey
FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

CREATE INDEX IF NOT EXISTS idx_pediatric_assessments_tenant_id 
ON public.pediatric_assessments(tenant_id);

-- Add tenant_id to surgical_assessments
ALTER TABLE public.surgical_assessments
ADD COLUMN IF NOT EXISTS tenant_id uuid;

UPDATE public.surgical_assessments sa
SET tenant_id = f.tenant_id
FROM public.facilities f
WHERE sa.facility_id = f.id
AND sa.tenant_id IS NULL;

ALTER TABLE public.surgical_assessments
ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE public.surgical_assessments
ADD CONSTRAINT surgical_assessments_tenant_id_fkey
FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

CREATE INDEX IF NOT EXISTS idx_surgical_assessments_tenant_id 
ON public.surgical_assessments(tenant_id);