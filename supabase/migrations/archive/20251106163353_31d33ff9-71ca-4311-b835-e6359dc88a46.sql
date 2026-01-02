-- Phase 5: Infrastructure & Events

-- Step 1: Create user_preferences table
CREATE TABLE IF NOT EXISTS public.user_preferences (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE UNIQUE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  
  -- Locale and language
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'am', 'om', 'ti', 'so')),
  timezone TEXT DEFAULT 'Africa/Addis_Ababa',
  date_format TEXT DEFAULT 'DD/MM/YYYY',
  time_format TEXT DEFAULT '24h' CHECK (time_format IN ('12h', '24h')),
  
  -- Notification preferences
  enable_notifications BOOLEAN DEFAULT true,
  enable_email_notifications BOOLEAN DEFAULT true,
  enable_sms_notifications BOOLEAN DEFAULT false,
  enable_push_notifications BOOLEAN DEFAULT true,
  
  -- Quiet hours
  quiet_hours_enabled BOOLEAN DEFAULT false,
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  
  -- Digest settings
  daily_digest_enabled BOOLEAN DEFAULT false,
  daily_digest_time TIME DEFAULT '08:00',
  weekly_digest_enabled BOOLEAN DEFAULT false,
  weekly_digest_day INTEGER DEFAULT 1 CHECK (weekly_digest_day BETWEEN 0 AND 6), -- 0 = Sunday
  
  -- UI preferences
  theme TEXT DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  sidebar_collapsed BOOLEAN DEFAULT false,
  dashboard_layout JSONB DEFAULT '[]'::jsonb,
  
  -- Accessibility
  high_contrast BOOLEAN DEFAULT false,
  font_size TEXT DEFAULT 'medium' CHECK (font_size IN ('small', 'medium', 'large', 'x-large')),
  screen_reader_enabled BOOLEAN DEFAULT false,
  
  -- Clinical preferences
  default_patient_view TEXT DEFAULT 'list' CHECK (default_patient_view IN ('list', 'grid', 'timeline')),
  auto_save_clinical_notes BOOLEAN DEFAULT true,
  auto_save_interval_seconds INTEGER DEFAULT 30,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for user_preferences
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON public.user_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_tenant_id ON public.user_preferences(tenant_id);

-- Enable RLS on user_preferences
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- Step 2: Create notification_receipts table
CREATE TABLE IF NOT EXISTS public.notification_receipts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  notification_id UUID NOT NULL REFERENCES public.patient_notifications(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES public.users(id),
  
  -- Delivery tracking
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('in_app', 'email', 'sms', 'push')),
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'failed', 'bounced', 'read')),
  
  sent_at TIMESTAMP WITH TIME ZONE,
  delivered_at TIMESTAMP WITH TIME ZONE,
  read_at TIMESTAMP WITH TIME ZONE,
  failed_at TIMESTAMP WITH TIME ZONE,
  
  -- Failure tracking
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  last_retry_at TIMESTAMP WITH TIME ZONE,
  
  -- Engagement
  clicked BOOLEAN DEFAULT false,
  clicked_at TIMESTAMP WITH TIME ZONE,
  action_taken BOOLEAN DEFAULT false,
  action_taken_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  delivery_metadata JSONB,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for notification_receipts
CREATE INDEX IF NOT EXISTS idx_notification_receipts_tenant_id ON public.notification_receipts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notification_receipts_notification_id ON public.notification_receipts(notification_id);
CREATE INDEX IF NOT EXISTS idx_notification_receipts_recipient ON public.notification_receipts(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_notification_receipts_status ON public.notification_receipts(delivery_status);
CREATE INDEX IF NOT EXISTS idx_notification_receipts_sent_at ON public.notification_receipts(sent_at DESC);

-- Enable RLS on notification_receipts
ALTER TABLE public.notification_receipts ENABLE ROW LEVEL SECURITY;

-- Step 3: Create outbox_events table for event sourcing
CREATE TABLE IF NOT EXISTS public.outbox_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  
  -- Event identification
  event_type TEXT NOT NULL, -- e.g., 'patient.registered', 'visit.completed', 'order.placed'
  event_version TEXT NOT NULL DEFAULT 'v1',
  aggregate_type TEXT NOT NULL, -- e.g., 'patient', 'visit', 'order'
  aggregate_id UUID NOT NULL,
  
  -- Event payload
  payload JSONB NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  
  -- Causation and correlation for event chain tracking
  causation_id UUID, -- ID of the event that caused this event
  correlation_id UUID, -- ID linking related events in a business transaction
  
  -- Processing status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
  
  -- Processing tracking
  processed_at TIMESTAMP WITH TIME ZONE,
  processed_by TEXT, -- Service/worker that processed the event
  processing_attempts INTEGER DEFAULT 0,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  
  -- Failure tracking
  error_message TEXT,
  error_stack TEXT,
  
  -- Event metadata
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Partitioning hint for future scaling
  created_date DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Create indexes for outbox_events
CREATE INDEX IF NOT EXISTS idx_outbox_events_tenant_id ON public.outbox_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_status ON public.outbox_events(status) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate ON public.outbox_events(aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_type ON public.outbox_events(event_type);
CREATE INDEX IF NOT EXISTS idx_outbox_events_correlation ON public.outbox_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_events_created_at ON public.outbox_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_events_next_retry ON public.outbox_events(next_retry_at) WHERE status = 'failed' AND next_retry_at IS NOT NULL;

-- Enable RLS on outbox_events
ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;

-- Step 4: Create kpi_definitions table
CREATE TABLE IF NOT EXISTS public.kpi_definitions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  
  -- KPI identification
  kpi_code TEXT NOT NULL, -- e.g., 'avg_wait_time', 'bed_occupancy_rate'
  kpi_name TEXT NOT NULL,
  kpi_description TEXT,
  kpi_category TEXT NOT NULL CHECK (kpi_category IN ('operational', 'clinical', 'financial', 'quality', 'patient_satisfaction', 'workforce')),
  
  -- Calculation
  calculation_method TEXT NOT NULL, -- 'sql_query', 'aggregation', 'formula', 'manual'
  calculation_formula TEXT, -- SQL query or formula
  aggregation_type TEXT CHECK (aggregation_type IN ('sum', 'avg', 'count', 'min', 'max', 'rate', 'percentage')),
  
  -- Unit and formatting
  unit TEXT, -- 'minutes', 'percentage', 'currency', 'count'
  display_format TEXT, -- '0.00', '0%', '$0,0.00'
  
  -- Targets
  has_target BOOLEAN DEFAULT false,
  target_direction TEXT CHECK (target_direction IN ('higher_better', 'lower_better', 'target_value')),
  
  -- Measurement frequency
  measurement_frequency TEXT CHECK (measurement_frequency IN ('real_time', 'hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
  
  -- Scope
  scope_level TEXT NOT NULL CHECK (scope_level IN ('tenant', 'facility', 'department', 'ward', 'user')),
  
  is_active BOOLEAN DEFAULT true,
  is_published BOOLEAN DEFAULT false,
  
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  UNIQUE (tenant_id, kpi_code)
);

-- Create indexes for kpi_definitions
CREATE INDEX IF NOT EXISTS idx_kpi_definitions_tenant_id ON public.kpi_definitions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kpi_definitions_code ON public.kpi_definitions(kpi_code);
CREATE INDEX IF NOT EXISTS idx_kpi_definitions_category ON public.kpi_definitions(kpi_category);
CREATE INDEX IF NOT EXISTS idx_kpi_definitions_active ON public.kpi_definitions(is_active, is_published);

-- Enable RLS on kpi_definitions
ALTER TABLE public.kpi_definitions ENABLE ROW LEVEL SECURITY;

-- Step 5: Create kpi_values table
CREATE TABLE IF NOT EXISTS public.kpi_values (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  kpi_definition_id UUID NOT NULL REFERENCES public.kpi_definitions(id) ON DELETE CASCADE,
  
  -- Scope identifiers
  facility_id UUID REFERENCES public.facilities(id),
  department_id UUID REFERENCES public.departments(id),
  ward_id UUID REFERENCES public.wards(id),
  user_id UUID REFERENCES public.users(id),
  
  -- Time period
  measurement_date DATE NOT NULL,
  measurement_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  period_start TIMESTAMP WITH TIME ZONE,
  period_end TIMESTAMP WITH TIME ZONE,
  
  -- Value
  value NUMERIC NOT NULL,
  numerator NUMERIC, -- For rates and percentages
  denominator NUMERIC, -- For rates and percentages
  
  -- Comparison to target
  target_value NUMERIC,
  variance NUMERIC, -- Difference from target
  variance_percentage NUMERIC,
  status TEXT CHECK (status IN ('on_track', 'at_risk', 'off_track', 'exceeds_target')),
  
  -- Metadata
  calculation_metadata JSONB,
  data_quality_score NUMERIC CHECK (data_quality_score BETWEEN 0 AND 1),
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Ensure one value per scope per period
  UNIQUE (kpi_definition_id, facility_id, department_id, ward_id, user_id, measurement_date)
);

-- Create indexes for kpi_values
CREATE INDEX IF NOT EXISTS idx_kpi_values_tenant_id ON public.kpi_values(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kpi_values_definition_id ON public.kpi_values(kpi_definition_id);
CREATE INDEX IF NOT EXISTS idx_kpi_values_facility_id ON public.kpi_values(facility_id);
CREATE INDEX IF NOT EXISTS idx_kpi_values_department_id ON public.kpi_values(department_id);
CREATE INDEX IF NOT EXISTS idx_kpi_values_measurement_date ON public.kpi_values(measurement_date DESC);
CREATE INDEX IF NOT EXISTS idx_kpi_values_timestamp ON public.kpi_values(measurement_timestamp DESC);

-- Enable RLS on kpi_values
ALTER TABLE public.kpi_values ENABLE ROW LEVEL SECURITY;

-- Step 6: Create kpi_targets table
CREATE TABLE IF NOT EXISTS public.kpi_targets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  kpi_definition_id UUID NOT NULL REFERENCES public.kpi_definitions(id) ON DELETE CASCADE,
  
  -- Scope identifiers
  facility_id UUID REFERENCES public.facilities(id),
  department_id UUID REFERENCES public.departments(id),
  ward_id UUID REFERENCES public.wards(id),
  
  -- Time period
  effective_from DATE NOT NULL,
  effective_to DATE,
  
  -- Target values
  target_value NUMERIC NOT NULL,
  threshold_red NUMERIC, -- Below this is critical
  threshold_yellow NUMERIC, -- Below this is warning
  threshold_green NUMERIC, -- Above this is good
  
  -- Target type
  target_type TEXT NOT NULL CHECK (target_type IN ('absolute', 'percentage', 'benchmark')),
  benchmark_source TEXT,
  
  notes TEXT,
  
  set_by UUID REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for kpi_targets
CREATE INDEX IF NOT EXISTS idx_kpi_targets_tenant_id ON public.kpi_targets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kpi_targets_definition_id ON public.kpi_targets(kpi_definition_id);
CREATE INDEX IF NOT EXISTS idx_kpi_targets_facility_id ON public.kpi_targets(facility_id);
CREATE INDEX IF NOT EXISTS idx_kpi_targets_effective_dates ON public.kpi_targets(effective_from, effective_to);

-- Enable RLS on kpi_targets
ALTER TABLE public.kpi_targets ENABLE ROW LEVEL SECURITY;

-- Step 7: Create comprehensive audit_log table
CREATE TABLE IF NOT EXISTS public.audit_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  
  -- Event identification
  event_type TEXT NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE', 'ACCESS', 'EXPORT', 'PRINT', 'LOGIN', 'LOGOUT'
  entity_type TEXT NOT NULL, -- 'patient', 'visit', 'order', 'user', etc.
  entity_id UUID,
  entity_name TEXT,
  
  -- Actor information
  actor_user_id UUID REFERENCES public.users(id),
  actor_username TEXT,
  actor_role TEXT,
  actor_ip_address INET,
  actor_user_agent TEXT,
  
  -- Action details
  action TEXT NOT NULL,
  action_category TEXT CHECK (action_category IN ('data_access', 'data_modification', 'authentication', 'authorization', 'configuration', 'system')),
  
  -- Change tracking
  old_values JSONB,
  new_values JSONB,
  changed_fields TEXT[],
  
  -- Context
  facility_id UUID REFERENCES public.facilities(id),
  department_id UUID REFERENCES public.departments(id),
  request_id UUID, -- For tracing related actions
  session_id UUID,
  
  -- Compliance and security
  sensitivity_level TEXT CHECK (sensitivity_level IN ('low', 'medium', 'high', 'critical')),
  compliance_tags TEXT[], -- e.g., ['HIPAA', 'GDPR', 'PHI_ACCESS']
  is_suspicious BOOLEAN DEFAULT false,
  suspicious_reason TEXT,
  
  -- Metadata
  metadata JSONB,
  
  -- Immutable timestamp
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Partitioning hint
  created_date DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Create indexes for audit_log
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id ON public.audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON public.audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON public.audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON public.audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_facility ON public.audit_log(facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_suspicious ON public.audit_log(is_suspicious) WHERE is_suspicious = true;
CREATE INDEX IF NOT EXISTS idx_audit_log_compliance ON public.audit_log USING GIN(compliance_tags);

-- Enable RLS on audit_log (read-only for non-super-admins)
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Step 8: Create RLS policies

-- User preferences policies
CREATE POLICY "Users can view their own preferences" ON public.user_preferences
  FOR SELECT USING (user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid()));

CREATE POLICY "Users can update their own preferences" ON public.user_preferences
  FOR ALL USING (user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid()));

-- Notification receipts policies
CREATE POLICY "Users can view their notification receipts" ON public.notification_receipts
  FOR SELECT USING (
    recipient_user_id IN (SELECT id FROM public.users WHERE auth_user_id = auth.uid())
  );

CREATE POLICY "System can manage notification receipts" ON public.notification_receipts
  FOR ALL USING (is_super_admin());

-- Outbox events policies
CREATE POLICY "System can manage outbox events" ON public.outbox_events
  FOR ALL USING (is_super_admin());

CREATE POLICY "Facility staff can view their facility events" ON public.outbox_events
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
  );

-- KPI definitions policies
CREATE POLICY "Staff can view KPI definitions" ON public.kpi_definitions
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND is_published = true
  );

CREATE POLICY "Admins can manage KPI definitions" ON public.kpi_definitions
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('hospital_ceo', 'medical_director', 'super_admin')
    )
  );

-- KPI values policies
CREATE POLICY "Staff can view KPI values" ON public.kpi_values
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND (
      facility_id = get_user_facility_id() OR
      facility_id IS NULL OR
      is_super_admin()
    )
  );

CREATE POLICY "System can manage KPI values" ON public.kpi_values
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    OR is_super_admin()
  );

-- KPI targets policies
CREATE POLICY "Staff can view KPI targets" ON public.kpi_targets
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
  );

CREATE POLICY "Admins can manage KPI targets" ON public.kpi_targets
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('hospital_ceo', 'medical_director', 'super_admin')
    )
  );

-- Audit log policies (read-only for authorized users)
CREATE POLICY "Admins can view audit logs" ON public.audit_log
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('hospital_ceo', 'medical_director', 'super_admin')
    )
  );

CREATE POLICY "System can insert audit logs" ON public.audit_log
  FOR INSERT WITH CHECK (true);

-- Step 9: Create triggers for updated_at
CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_notification_receipts_updated_at
  BEFORE UPDATE ON public.notification_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_kpi_definitions_updated_at
  BEFORE UPDATE ON public.kpi_definitions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_kpi_values_updated_at
  BEFORE UPDATE ON public.kpi_values
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_kpi_targets_updated_at
  BEFORE UPDATE ON public.kpi_targets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Step 10: Add documentation comments
COMMENT ON TABLE public.user_preferences IS 'User-specific preferences for UI, notifications, and clinical workflows';
COMMENT ON TABLE public.notification_receipts IS 'Delivery tracking for notifications across multiple channels - in-app, email, SMS, push';
COMMENT ON TABLE public.outbox_events IS 'Event sourcing outbox for reliable async processing and integration events';
COMMENT ON TABLE public.kpi_definitions IS 'KPI definitions with calculation formulas and measurement frequencies';
COMMENT ON TABLE public.kpi_values IS 'Time-series KPI measurements with variance tracking against targets';
COMMENT ON TABLE public.kpi_targets IS 'Target values for KPIs with red/yellow/green thresholds';
COMMENT ON TABLE public.audit_log IS 'Comprehensive immutable audit trail for compliance (HIPAA, GDPR) - tracks all data access and modifications';