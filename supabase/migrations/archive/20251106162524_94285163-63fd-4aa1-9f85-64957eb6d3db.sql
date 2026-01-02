-- Phase 2: Order System Normalization

-- Step 1: Create patient_orders container table
CREATE TABLE IF NOT EXISTS public.patient_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  ordered_by UUID NOT NULL REFERENCES public.users(id),
  order_type TEXT NOT NULL CHECK (order_type IN ('lab', 'imaging', 'medication', 'procedure', 'treatment')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'in_progress', 'completed', 'cancelled', 'discontinued')),
  urgency TEXT DEFAULT 'routine' CHECK (urgency IN ('routine', 'urgent', 'STAT', 'emergency')),
  ordered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  cancelled_by UUID REFERENCES public.users(id),
  cancellation_reason TEXT,
  clinical_notes TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid', 'waived')),
  total_amount NUMERIC DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for patient_orders
CREATE INDEX IF NOT EXISTS idx_patient_orders_tenant_id ON public.patient_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_orders_visit_id ON public.patient_orders(visit_id);
CREATE INDEX IF NOT EXISTS idx_patient_orders_patient_id ON public.patient_orders(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_orders_facility_id ON public.patient_orders(facility_id);
CREATE INDEX IF NOT EXISTS idx_patient_orders_type_status ON public.patient_orders(order_type, status);
CREATE INDEX IF NOT EXISTS idx_patient_orders_ordered_at ON public.patient_orders(ordered_at DESC);

-- Enable RLS on patient_orders
ALTER TABLE public.patient_orders ENABLE ROW LEVEL SECURITY;

-- Step 2: Create patient_order_items table
CREATE TABLE IF NOT EXISTS public.patient_order_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.patient_orders(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  item_type TEXT NOT NULL CHECK (item_type IN ('lab_test', 'imaging_study', 'medication', 'procedure', 'treatment')),
  item_code TEXT,
  item_name TEXT NOT NULL,
  item_category TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'collected', 'in_progress', 'completed', 'cancelled')),
  result_data JSONB,
  result_text TEXT,
  result_value TEXT,
  reference_range TEXT,
  unit_of_measure TEXT,
  abnormal_flag TEXT CHECK (abnormal_flag IN ('normal', 'low', 'high', 'critical_low', 'critical_high')),
  collected_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  reported_by UUID REFERENCES public.users(id),
  verified_by UUID REFERENCES public.users(id),
  verified_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for patient_order_items
CREATE INDEX IF NOT EXISTS idx_patient_order_items_order_id ON public.patient_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_patient_order_items_tenant_id ON public.patient_order_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_order_items_type ON public.patient_order_items(item_type);
CREATE INDEX IF NOT EXISTS idx_patient_order_items_status ON public.patient_order_items(status);

-- Enable RLS on patient_order_items
ALTER TABLE public.patient_order_items ENABLE ROW LEVEL SECURITY;

-- Step 3: Create rx_items (prescription items) table
CREATE TABLE IF NOT EXISTS public.rx_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.patient_orders(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  medication_name TEXT NOT NULL,
  generic_name TEXT,
  dosage TEXT NOT NULL,
  dosage_form TEXT,
  strength TEXT,
  route TEXT NOT NULL DEFAULT 'oral',
  frequency TEXT NOT NULL,
  duration TEXT,
  quantity INTEGER,
  refills INTEGER DEFAULT 0,
  unit_price NUMERIC,
  total_price NUMERIC,
  start_date DATE,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispensed', 'partially_dispensed', 'cancelled', 'discontinued')),
  dispensed_quantity INTEGER DEFAULT 0,
  dispensed_at TIMESTAMP WITH TIME ZONE,
  dispensed_by UUID REFERENCES public.users(id),
  sent_outside BOOLEAN DEFAULT false,
  pharmacy_notes TEXT,
  prescriber_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for rx_items
CREATE INDEX IF NOT EXISTS idx_rx_items_order_id ON public.rx_items(order_id);
CREATE INDEX IF NOT EXISTS idx_rx_items_tenant_id ON public.rx_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rx_items_status ON public.rx_items(status);
CREATE INDEX IF NOT EXISTS idx_rx_items_medication_name ON public.rx_items(medication_name);

-- Enable RLS on rx_items
ALTER TABLE public.rx_items ENABLE ROW LEVEL SECURITY;

-- Step 4: Migrate lab_orders to new structure
INSERT INTO public.patient_orders (
  id, tenant_id, visit_id, patient_id, facility_id, ordered_by,
  order_type, status, urgency, ordered_at, completed_at,
  clinical_notes, payment_status, total_amount, created_at, updated_at
)
SELECT 
  lo.id,
  COALESCE(lo.tenant_id, '00000000-0000-0000-0000-000000000001'),
  lo.visit_id,
  lo.patient_id,
  v.facility_id,
  lo.ordered_by,
  'lab' as order_type,
  CASE 
    WHEN lo.status = 'completed' THEN 'completed'
    WHEN lo.status = 'pending' THEN 'pending'
    WHEN lo.status = 'collected' THEN 'in_progress'
    ELSE 'pending'
  END as status,
  CASE 
    WHEN lo.urgency = 'STAT' THEN 'STAT'
    WHEN lo.urgency = 'urgent' THEN 'urgent'
    ELSE 'routine'
  END as urgency,
  lo.ordered_at,
  lo.completed_at,
  lo.notes,
  lo.payment_status,
  COALESCE(lo.amount, 0),
  lo.created_at,
  lo.updated_at
FROM public.lab_orders lo
JOIN public.visits v ON v.id = lo.visit_id
ON CONFLICT (id) DO NOTHING;

-- Migrate lab_orders items
INSERT INTO public.patient_order_items (
  tenant_id, order_id, item_type, item_code, item_name, status,
  result_text, result_value, reference_range, unit_of_measure,
  collected_at, completed_at, notes, created_at, updated_at
)
SELECT 
  COALESCE(lo.tenant_id, '00000000-0000-0000-0000-000000000001'),
  lo.id,
  'lab_test' as item_type,
  lo.test_code,
  lo.test_name,
  CASE 
    WHEN lo.status = 'completed' THEN 'completed'
    WHEN lo.status = 'collected' THEN 'in_progress'
    ELSE 'pending'
  END as status,
  lo.result,
  lo.result_value,
  lo.reference_range,
  (SELECT unit_of_measure FROM public.lab_test_master WHERE test_code = lo.test_code LIMIT 1),
  lo.collected_at,
  lo.completed_at,
  lo.notes,
  lo.created_at,
  lo.updated_at
FROM public.lab_orders lo;

-- Step 5: Migrate imaging_orders to new structure
INSERT INTO public.patient_orders (
  id, tenant_id, visit_id, patient_id, facility_id, ordered_by,
  order_type, status, urgency, ordered_at, completed_at,
  clinical_notes, payment_status, total_amount, created_at, updated_at
)
SELECT 
  io.id,
  COALESCE(io.tenant_id, '00000000-0000-0000-0000-000000000001'),
  io.visit_id,
  io.patient_id,
  v.facility_id,
  io.ordered_by,
  'imaging' as order_type,
  CASE 
    WHEN io.status = 'completed' THEN 'completed'
    WHEN io.status = 'pending' THEN 'pending'
    WHEN io.status = 'scheduled' THEN 'approved'
    ELSE 'pending'
  END as status,
  CASE 
    WHEN io.urgency = 'urgent' THEN 'urgent'
    WHEN io.urgency = 'emergency' THEN 'emergency'
    ELSE 'routine'
  END as urgency,
  io.ordered_at,
  io.completed_at,
  io.notes,
  io.payment_status,
  COALESCE(io.amount, 0),
  io.created_at,
  io.updated_at
FROM public.imaging_orders io
JOIN public.visits v ON v.id = io.visit_id
ON CONFLICT (id) DO NOTHING;

-- Migrate imaging_orders items
INSERT INTO public.patient_order_items (
  tenant_id, order_id, item_type, item_code, item_name, item_category,
  status, result_text, result_data, completed_at, notes, created_at, updated_at
)
SELECT 
  COALESCE(io.tenant_id, '00000000-0000-0000-0000-000000000001'),
  io.id,
  'imaging_study' as item_type,
  io.study_code,
  io.study_name,
  io.body_part,
  CASE 
    WHEN io.status = 'completed' THEN 'completed'
    WHEN io.status = 'scheduled' THEN 'pending'
    ELSE 'pending'
  END as status,
  CONCAT_WS(E'\n\n', 
    CASE WHEN io.findings IS NOT NULL THEN 'FINDINGS: ' || io.findings END,
    CASE WHEN io.impression IS NOT NULL THEN 'IMPRESSION: ' || io.impression END
  ),
  jsonb_build_object(
    'findings', io.findings,
    'impression', io.impression,
    'body_part', io.body_part
  ),
  io.completed_at,
  io.notes,
  io.created_at,
  io.updated_at
FROM public.imaging_orders io;

-- Step 6: Migrate medication_orders to new structure
INSERT INTO public.patient_orders (
  id, tenant_id, visit_id, patient_id, facility_id, ordered_by,
  order_type, status, urgency, ordered_at, completed_at,
  clinical_notes, payment_status, total_amount, created_at, updated_at
)
SELECT 
  mo.id,
  COALESCE(mo.tenant_id, '00000000-0000-0000-0000-000000000001'),
  mo.visit_id,
  mo.patient_id,
  v.facility_id,
  mo.ordered_by,
  'medication' as order_type,
  CASE 
    WHEN mo.status = 'dispensed' THEN 'completed'
    WHEN mo.status = 'pending' THEN 'pending'
    WHEN mo.status = 'approved' THEN 'approved'
    ELSE 'pending'
  END as status,
  'routine' as urgency,
  mo.ordered_at,
  mo.dispensed_at as completed_at,
  mo.notes,
  mo.payment_status,
  COALESCE(mo.amount, 0),
  mo.created_at,
  mo.updated_at
FROM public.medication_orders mo
JOIN public.visits v ON v.id = mo.visit_id
ON CONFLICT (id) DO NOTHING;

-- Migrate medication_orders to rx_items
INSERT INTO public.rx_items (
  tenant_id, order_id, medication_name, generic_name, dosage, route,
  frequency, duration, quantity, refills, status, dispensed_at,
  sent_outside, prescriber_notes, created_at, updated_at
)
SELECT 
  COALESCE(mo.tenant_id, '00000000-0000-0000-0000-000000000001'),
  mo.id,
  mo.medication_name,
  mo.generic_name,
  mo.dosage,
  mo.route,
  mo.frequency,
  mo.duration,
  mo.quantity,
  mo.refills,
  CASE 
    WHEN mo.status = 'dispensed' THEN 'dispensed'
    WHEN mo.status = 'pending' THEN 'pending'
    ELSE 'pending'
  END as status,
  mo.dispensed_at,
  mo.sent_outside,
  mo.notes,
  mo.created_at,
  mo.updated_at
FROM public.medication_orders mo;

-- Step 7: Create RLS policies for patient_orders
CREATE POLICY "Facility staff can view orders" ON public.patient_orders
  FOR SELECT USING (
    tenant_id = get_user_tenant_id() 
    AND facility_id = get_user_facility_id()
  );

CREATE POLICY "Medical staff can create orders" ON public.patient_orders
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'nurse')
    )
  );

CREATE POLICY "Medical staff can update orders" ON public.patient_orders
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND facility_id = get_user_facility_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'nurse', 'pharmacist', 'lab_technician', 'imaging_technician')
    )
  );

CREATE POLICY "Super admins can manage all orders" ON public.patient_orders
  FOR ALL USING (is_super_admin());

-- Step 8: Create RLS policies for patient_order_items
CREATE POLICY "Facility staff can view order items" ON public.patient_order_items
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.patient_orders 
      WHERE id = patient_order_items.order_id 
      AND facility_id = get_user_facility_id()
    )
  );

CREATE POLICY "Medical and technical staff can manage order items" ON public.patient_order_items
  FOR ALL USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'nurse', 'lab_technician', 'imaging_technician', 'radiologist')
    )
  );

CREATE POLICY "Super admins can manage all order items" ON public.patient_order_items
  FOR ALL USING (is_super_admin());

-- Step 9: Create RLS policies for rx_items
CREATE POLICY "Facility staff can view rx items" ON public.rx_items
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.patient_orders 
      WHERE id = rx_items.order_id 
      AND facility_id = get_user_facility_id()
    )
  );

CREATE POLICY "Prescribers can create rx items" ON public.rx_items
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer')
    )
  );

CREATE POLICY "Pharmacists can update rx items" ON public.rx_items
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('doctor', 'clinical_officer', 'pharmacist')
    )
  );

CREATE POLICY "Super admins can manage all rx items" ON public.rx_items
  FOR ALL USING (is_super_admin());

-- Step 10: Create triggers for updated_at
CREATE TRIGGER update_patient_orders_updated_at
  BEFORE UPDATE ON public.patient_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_patient_order_items_updated_at
  BEFORE UPDATE ON public.patient_order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_rx_items_updated_at
  BEFORE UPDATE ON public.rx_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Step 11: Add comments to document migration
COMMENT ON TABLE public.patient_orders IS 'Normalized order container table - replaces separate lab_orders, imaging_orders, medication_orders tables';
COMMENT ON TABLE public.patient_order_items IS 'Individual items within orders - stores test results, imaging findings, procedure outcomes';
COMMENT ON TABLE public.rx_items IS 'Prescription medication items - detailed medication orders with dispensing tracking';

-- Note: Old tables (lab_orders, imaging_orders, medication_orders) are kept for backward compatibility
-- They can be deprecated/removed in a future migration after full system migration