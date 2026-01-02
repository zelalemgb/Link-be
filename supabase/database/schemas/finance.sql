-- Finance schema definitions
-- Contains base tables and constraints for payment tracking.

CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  visit_id UUID NOT NULL REFERENCES public.visits(id),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  cashier_id UUID NOT NULL REFERENCES public.users(id),
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_status public.payment_status_enum NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  CONSTRAINT payments_total_amount_non_negative CHECK (total_amount >= 0),
  CONSTRAINT payments_amount_paid_non_negative CHECK (amount_paid >= 0),
  CONSTRAINT payments_amount_due_non_negative CHECK (amount_due >= 0),
  CONSTRAINT payments_amount_consistency CHECK (
    amount_paid <= total_amount
    AND amount_due = GREATEST(total_amount - amount_paid, 0)
  )
);

-- Ensure payments.updated_at reflects the latest modification timestamp
CREATE TRIGGER update_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.payment_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (
    item_type IN ('consultation', 'service', 'medication', 'lab_test', 'imaging', 'procedure')
  ),
  item_reference_id UUID,
  description TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  subtotal NUMERIC(10,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (
    payment_method IN (
      'cash',
      'insurance',
      'credit',
      'free',
      'voucher_manual',
      'voucher_digital',
      'mobile_money',
      'bank_transfer',
      'manual_other',
      'digital_other'
    )
  ),
  insurance_provider TEXT,
  insurance_claim_number TEXT,
  payment_status public.payment_status_enum NOT NULL DEFAULT 'pending',
  discount_percentage NUMERIC(5,2) DEFAULT 0,
  discount_amount NUMERIC(10,2) DEFAULT 0,
  final_amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  CONSTRAINT payment_line_items_unit_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT payment_line_items_quantity_non_negative CHECK (quantity >= 0),
  CONSTRAINT payment_line_items_subtotal_non_negative CHECK (subtotal >= 0),
  CONSTRAINT payment_line_items_final_amount_non_negative CHECK (final_amount >= 0),
  CONSTRAINT payment_line_items_discount_bounds CHECK (
    COALESCE(discount_amount, 0) BETWEEN 0 AND subtotal
  ),
  CONSTRAINT payment_line_items_subtotal_calculation CHECK (
    subtotal = (unit_price * quantity)::NUMERIC(10,2)
  ),
  CONSTRAINT payment_line_items_final_amount_calculation CHECK (
    final_amount = subtotal - COALESCE(discount_amount, 0)
  )
);

CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  cashier_id UUID NOT NULL REFERENCES public.users(id),
  amount NUMERIC(10,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (
    payment_method IN (
      'cash',
      'insurance',
      'credit',
      'mobile_money',
      'bank_transfer',
      'check',
      'voucher_manual',
      'voucher_digital',
      'manual_other',
      'digital_other'
    )
  ),
  reference_number TEXT,
  transaction_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_transactions_amount_non_negative CHECK (amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_payments_visit_id ON public.payments(visit_id);
CREATE INDEX IF NOT EXISTS idx_payments_patient_id ON public.payments(patient_id);
CREATE INDEX IF NOT EXISTS idx_payments_facility_id ON public.payments(facility_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_tenant_facility
  ON public.payments(tenant_id, facility_id);
CREATE INDEX IF NOT EXISTS idx_payments_status_created
  ON public.payments(payment_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_line_items_payment_id
  ON public.payment_line_items(payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_payment_id
  ON public.payment_transactions(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_payment
  ON public.payment_transactions(payment_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_cashier
  ON public.payment_transactions(cashier_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_tenant_id
  ON public.payment_transactions(tenant_id);

