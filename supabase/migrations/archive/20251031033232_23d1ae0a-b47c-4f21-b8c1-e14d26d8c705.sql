-- Add sample rejection fields to lab_orders table
ALTER TABLE public.lab_orders 
ADD COLUMN IF NOT EXISTS rejection_reason text,
ADD COLUMN IF NOT EXISTS rejected_by uuid,
ADD COLUMN IF NOT EXISTS rejected_at timestamp with time zone;

-- Add comment for clarity
COMMENT ON COLUMN public.lab_orders.rejection_reason IS 'Reason for sample rejection if applicable';
COMMENT ON COLUMN public.lab_orders.rejected_by IS 'User who rejected the sample';
COMMENT ON COLUMN public.lab_orders.rejected_at IS 'Timestamp when sample was rejected';
