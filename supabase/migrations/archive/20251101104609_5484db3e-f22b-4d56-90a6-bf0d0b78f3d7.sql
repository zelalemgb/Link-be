-- Add payment tracking columns to medication_orders table
ALTER TABLE public.medication_orders
ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('paid', 'unpaid')),
ADD COLUMN payment_mode text CHECK (payment_mode IN ('cash', 'free', 'insurance', 'credit')),
ADD COLUMN amount numeric(10, 2),
ADD COLUMN paid_at timestamp with time zone;

-- Create index for faster payment status queries
CREATE INDEX idx_medication_orders_payment_status ON public.medication_orders(payment_status);

-- Add comment for documentation
COMMENT ON COLUMN public.medication_orders.payment_status IS 'Payment status: paid or unpaid';
COMMENT ON COLUMN public.medication_orders.payment_mode IS 'Mode of payment: cash, free, insurance, or credit';
COMMENT ON COLUMN public.medication_orders.amount IS 'Amount charged for the medication';
COMMENT ON COLUMN public.medication_orders.paid_at IS 'Timestamp when payment was made';