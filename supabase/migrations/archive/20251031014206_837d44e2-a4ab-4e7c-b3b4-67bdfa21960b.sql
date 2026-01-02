-- Create payments table to track payment sessions
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  facility_id UUID NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'partial', 'paid', 'cancelled')),
  cashier_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

-- Create payment line items for individual services/products
CREATE TABLE public.payment_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('consultation', 'service', 'medication', 'lab_test', 'imaging', 'procedure')),
  item_reference_id UUID,
  description TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  subtotal NUMERIC(10,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'insurance', 'credit', 'free')),
  insurance_provider TEXT,
  insurance_claim_number TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'refunded')),
  discount_percentage NUMERIC(5,2) DEFAULT 0,
  discount_amount NUMERIC(10,2) DEFAULT 0,
  final_amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

-- Create payment transactions for actual payment records
CREATE TABLE public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id),
  amount NUMERIC(10,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'insurance', 'credit', 'mobile_money', 'bank_transfer', 'check')),
  reference_number TEXT,
  transaction_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  cashier_id UUID NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for payments
CREATE POLICY "Staff can view facility payments"
  ON public.payments
  FOR SELECT
  USING (
    facility_id = get_user_facility_id() OR is_super_admin()
  );

CREATE POLICY "Staff can create payments"
  ON public.payments
  FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('finance', 'receptionist', 'admin', 'super_admin')
    )
  );

CREATE POLICY "Staff can update payments"
  ON public.payments
  FOR UPDATE
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('finance', 'receptionist', 'admin', 'super_admin')
    )
  );

-- RLS Policies for payment line items
CREATE POLICY "Staff can view payment line items"
  ON public.payment_line_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM payments p
      WHERE p.id = payment_line_items.payment_id
      AND (p.facility_id = get_user_facility_id() OR is_super_admin())
    )
  );

CREATE POLICY "Staff can manage payment line items"
  ON public.payment_line_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM payments p
      JOIN users u ON u.auth_user_id = auth.uid()
      WHERE p.id = payment_line_items.payment_id
      AND p.facility_id = get_user_facility_id()
      AND u.user_role IN ('finance', 'receptionist', 'admin', 'super_admin')
    )
  );

-- RLS Policies for payment transactions
CREATE POLICY "Staff can view payment transactions"
  ON public.payment_transactions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM payments p
      WHERE p.id = payment_transactions.payment_id
      AND (p.facility_id = get_user_facility_id() OR is_super_admin())
    )
  );

CREATE POLICY "Staff can create payment transactions"
  ON public.payment_transactions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM payments p
      JOIN users u ON u.auth_user_id = auth.uid()
      WHERE p.id = payment_transactions.payment_id
      AND p.facility_id = get_user_facility_id()
      AND u.user_role IN ('finance', 'receptionist', 'admin', 'super_admin')
    )
  );

-- Create indexes for performance
CREATE INDEX idx_payments_visit_id ON public.payments(visit_id);
CREATE INDEX idx_payments_patient_id ON public.payments(patient_id);
CREATE INDEX idx_payments_facility_id ON public.payments(facility_id);
CREATE INDEX idx_payments_status ON public.payments(payment_status);
CREATE INDEX idx_payment_line_items_payment_id ON public.payment_line_items(payment_id);
CREATE INDEX idx_payment_transactions_payment_id ON public.payment_transactions(payment_id);

-- Trigger for updated_at
CREATE TRIGGER update_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();