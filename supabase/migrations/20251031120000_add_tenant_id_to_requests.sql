
-- Add tenant_id to request_for_resupply
ALTER TABLE public.request_for_resupply
ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

-- Add tenant_id to request_line_items
ALTER TABLE public.request_line_items
ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

-- Update RLS policies to include tenant_id check (optional but good practice)
-- Ensuring existing RLS policies might need access to tenant_id if we switch to multi-tenant RLS
