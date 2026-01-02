-- Create imaging order templates table
CREATE TABLE IF NOT EXISTS public.imaging_order_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  template_data JSONB NOT NULL,
  created_by UUID NOT NULL REFERENCES public.users(id),
  facility_id UUID REFERENCES public.facilities(id),
  is_shared BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.imaging_order_templates ENABLE ROW LEVEL SECURITY;

-- Allow users to view their own templates and shared templates from their facility
CREATE POLICY "Users can view own and shared facility templates"
ON public.imaging_order_templates
FOR SELECT
USING (
  created_by IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  OR (is_shared = true AND facility_id = (
    SELECT facility_id FROM public.users WHERE auth_user_id = auth.uid()
  ))
);

-- Allow users to create their own templates
CREATE POLICY "Users can create own templates"
ON public.imaging_order_templates
FOR INSERT
WITH CHECK (
  created_by IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
);

-- Allow users to update their own templates
CREATE POLICY "Users can update own templates"
ON public.imaging_order_templates
FOR UPDATE
USING (
  created_by IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
);

-- Allow users to delete their own templates
CREATE POLICY "Users can delete own templates"
ON public.imaging_order_templates
FOR DELETE
USING (
  created_by IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
);

-- Add updated_at trigger
CREATE TRIGGER update_imaging_order_templates_updated_at
  BEFORE UPDATE ON public.imaging_order_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create index for faster queries
CREATE INDEX idx_imaging_order_templates_facility ON public.imaging_order_templates(facility_id);
CREATE INDEX idx_imaging_order_templates_created_by ON public.imaging_order_templates(created_by);