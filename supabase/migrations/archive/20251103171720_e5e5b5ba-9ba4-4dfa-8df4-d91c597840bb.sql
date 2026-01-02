-- Add sent_outside field to medication_orders table
ALTER TABLE public.medication_orders
ADD COLUMN IF NOT EXISTS sent_outside boolean DEFAULT false;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_medication_orders_sent_outside 
ON public.medication_orders(sent_outside) 
WHERE sent_outside = true;

-- Add comment for documentation
COMMENT ON COLUMN public.medication_orders.sent_outside IS 'Indicates if the medication was prescribed to be obtained from outside pharmacy due to unavailability';