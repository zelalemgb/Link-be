-- Create patient_status_events table for state transition audit trail
CREATE TABLE IF NOT EXISTS public.patient_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  changed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_patient_status_events_visit_id 
  ON public.patient_status_events(visit_id);
CREATE INDEX IF NOT EXISTS idx_patient_status_events_patient_id 
  ON public.patient_status_events(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_status_events_created_at 
  ON public.patient_status_events(created_at DESC);

-- Trigger to auto-populate tenant_id from visit
CREATE OR REPLACE FUNCTION public.set_patient_status_event_tenant()
RETURNS TRIGGER AS $$
BEGIN
  -- Get tenant_id from the visit
  SELECT tenant_id INTO NEW.tenant_id
  FROM public.visits
  WHERE id = NEW.visit_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER set_patient_status_event_tenant_trigger
  BEFORE INSERT ON public.patient_status_events
  FOR EACH ROW
  EXECUTE FUNCTION public.set_patient_status_event_tenant();

-- Enable RLS
ALTER TABLE public.patient_status_events ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view events for their tenant
CREATE POLICY "Users can view events in their tenant"
  ON public.patient_status_events
  FOR SELECT
  USING (tenant_id = public.get_user_tenant_id());

-- RLS Policy: Service role can insert events
CREATE POLICY "Service role can insert events"
  ON public.patient_status_events
  FOR INSERT
  WITH CHECK (true);

-- Comment on table
COMMENT ON TABLE public.patient_status_events IS 'Audit trail for all patient state transitions, used by the state machine edge function';
