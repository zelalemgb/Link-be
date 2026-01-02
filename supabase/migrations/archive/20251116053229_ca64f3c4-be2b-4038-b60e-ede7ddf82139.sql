-- Phase 1: Event Sourcing Foundation (FINAL FIX)
-- Aligned with actual database schema

-- ======================================================================================
-- 1. CREATE patient_status_events TABLE
-- ======================================================================================

CREATE TABLE IF NOT EXISTS public.patient_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  
  previous_status text,
  new_status text NOT NULL,
  
  event_type text NOT NULL DEFAULT 'status_change',
  changed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  
  CONSTRAINT valid_status_values CHECK (
    new_status IN (
      'registered', 'at_triage', 'vitals_taken', 'with_doctor', 
      'awaiting_results', 'at_lab', 'at_imaging', 'at_pharmacy',
      'ready_for_discharge', 'discharged', 'admitted', 'cancelled'
    )
  ),
  
  CONSTRAINT valid_event_type CHECK (
    event_type IN ('status_change', 'payment_update', 'assessment_complete', 'order_placed')
  )
);

ALTER TABLE public.patient_status_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view events from their tenant"
  ON public.patient_status_events FOR SELECT
  USING (tenant_id = public.get_user_tenant_id() OR public.is_super_admin());

CREATE POLICY "System can insert status events"
  ON public.patient_status_events FOR INSERT
  WITH CHECK (true);

-- ======================================================================================
-- 2. CREATE INDEXES
-- ======================================================================================

CREATE INDEX idx_patient_status_events_visit_time 
  ON public.patient_status_events(visit_id, changed_at DESC);

CREATE INDEX idx_patient_status_events_facility_time 
  ON public.patient_status_events(facility_id, changed_at DESC) 
  WHERE new_status NOT IN ('discharged', 'cancelled');

CREATE INDEX idx_patient_status_events_tenant 
  ON public.patient_status_events(tenant_id);

CREATE INDEX idx_patient_status_events_patient 
  ON public.patient_status_events(patient_id, changed_at DESC);

-- ======================================================================================
-- 3. CREATE MATERIALIZED VIEW (Using only actual columns)
-- ======================================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.nurse_dashboard_queue AS
SELECT 
  v.id AS visit_id,
  v.patient_id,
  v.facility_id,
  v.tenant_id,
  v.status AS current_status,
  v.visit_date,
  v.created_at AS visit_created_at,
  v.status_updated_at,
  
  -- Patient information
  p.full_name AS patient_name,
  p.age AS patient_age,
  p.gender AS patient_gender,
  p.phone AS patient_phone,
  p.fayida_id,
  
  -- Visit metadata (only existing columns)
  v.reason AS visit_reason,
  v.provider,
  v.assigned_doctor,
  v.assessment_completed,
  v.assessed_at,
  v.assessed_by,
  v.journey_timeline,
  
  -- Payment status (aggregated)
  CASE 
    WHEN EXISTS (
      SELECT 1 FROM public.billing_items bi 
      WHERE bi.visit_id = v.id AND bi.payment_status = 'unpaid'
    ) THEN 'unpaid'
    WHEN EXISTS (
      SELECT 1 FROM public.billing_items bi 
      WHERE bi.visit_id = v.id AND bi.payment_status = 'paid'
    ) THEN 'paid'
    ELSE 'none'
  END AS payment_status,
  
  -- Wait time calculation
  EXTRACT(EPOCH FROM (now() - v.status_updated_at)) / 60 AS wait_time_minutes,
  
  -- Last status change info
  (
    SELECT jsonb_build_object(
      'previous_status', pse.previous_status,
      'changed_at', pse.changed_at,
      'changed_by', pse.changed_by
    )
    FROM public.patient_status_events pse
    WHERE pse.visit_id = v.id
    ORDER BY pse.changed_at DESC
    LIMIT 1
  ) AS last_status_change,
  
  -- Pending orders count
  (SELECT COUNT(*) FROM public.lab_orders lo 
   WHERE lo.visit_id = v.id AND lo.status = 'pending') AS pending_lab_orders,
  (SELECT COUNT(*) FROM public.imaging_orders io 
   WHERE io.visit_id = v.id AND io.status = 'pending') AS pending_imaging_orders,
  (SELECT COUNT(*) FROM public.medication_orders mo 
   WHERE mo.visit_id = v.id AND mo.status IN ('pending', 'approved')) AS pending_medication_orders

FROM public.visits v
INNER JOIN public.patients p ON p.id = v.patient_id
WHERE v.status NOT IN ('discharged', 'cancelled')
  AND v.visit_date >= CURRENT_DATE - INTERVAL '7 days';

CREATE UNIQUE INDEX idx_nurse_dashboard_queue_visit 
  ON public.nurse_dashboard_queue(visit_id);

CREATE INDEX idx_nurse_dashboard_queue_facility_status 
  ON public.nurse_dashboard_queue(facility_id, current_status, visit_created_at DESC);

CREATE INDEX idx_nurse_dashboard_queue_tenant 
  ON public.nurse_dashboard_queue(tenant_id);

-- ======================================================================================
-- 4. TRIGGER TO AUTO-POPULATE patient_status_events
-- ======================================================================================

CREATE OR REPLACE FUNCTION public.track_visit_status_changes()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id 
  FROM public.users 
  WHERE auth_user_id = auth.uid() 
  LIMIT 1;
  
  IF (TG_OP = 'INSERT') OR (OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO public.patient_status_events (
      tenant_id, facility_id, visit_id, patient_id,
      previous_status, new_status, event_type,
      changed_by, changed_at, metadata
    ) VALUES (
      NEW.tenant_id, NEW.facility_id, NEW.id, NEW.patient_id,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      NEW.status, 'status_change',
      COALESCE(v_user_id, NEW.created_by), now(),
      jsonb_build_object(
        'operation', TG_OP,
        'assessment_completed', NEW.assessment_completed,
        'journey_timeline', NEW.journey_timeline
      )
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trigger_track_visit_status_changes ON public.visits;
CREATE TRIGGER trigger_track_visit_status_changes
  AFTER INSERT OR UPDATE OF status ON public.visits
  FOR EACH ROW
  EXECUTE FUNCTION public.track_visit_status_changes();

-- ======================================================================================
-- 5. TRIGGER TO AUTO-REFRESH MATERIALIZED VIEW
-- ======================================================================================

CREATE OR REPLACE FUNCTION public.refresh_nurse_dashboard_queue()
RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.nurse_dashboard_queue;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trigger_refresh_dashboard_on_visit ON public.visits;
CREATE TRIGGER trigger_refresh_dashboard_on_visit
  AFTER INSERT OR UPDATE OR DELETE ON public.visits
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

DROP TRIGGER IF EXISTS trigger_refresh_dashboard_on_billing ON public.billing_items;
CREATE TRIGGER trigger_refresh_dashboard_on_billing
  AFTER INSERT OR UPDATE OF payment_status OR DELETE ON public.billing_items
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.refresh_nurse_dashboard_queue();

-- ======================================================================================
-- 6. BACKFILL EXISTING DATA
-- ======================================================================================

INSERT INTO public.patient_status_events (
  tenant_id, facility_id, visit_id, patient_id,
  previous_status, new_status, event_type,
  changed_by, changed_at, metadata
)
SELECT 
  v.tenant_id, v.facility_id, v.id, v.patient_id,
  NULL, v.status, 'status_change',
  v.created_by, v.status_updated_at,
  jsonb_build_object(
    'operation', 'BACKFILL',
    'assessment_completed', v.assessment_completed,
    'backfilled_at', now()
  )
FROM public.visits v
WHERE NOT EXISTS (
  SELECT 1 FROM public.patient_status_events pse 
  WHERE pse.visit_id = v.id
)
ON CONFLICT DO NOTHING;

-- ======================================================================================
-- 7. GRANT PERMISSIONS
-- ======================================================================================

GRANT SELECT ON public.nurse_dashboard_queue TO authenticated;
GRANT SELECT ON public.patient_status_events TO authenticated;

-- ======================================================================================
-- 8. HELPER FUNCTION FOR MANUAL REFRESH
-- ======================================================================================

CREATE OR REPLACE FUNCTION public.refresh_dashboard_view()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.nurse_dashboard_queue;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.refresh_dashboard_view() TO authenticated;