-- Add sent_outside field to lab_orders and imaging_orders tables

-- Add to lab_orders
ALTER TABLE lab_orders 
ADD COLUMN IF NOT EXISTS sent_outside boolean DEFAULT false;

-- Add to imaging_orders  
ALTER TABLE imaging_orders
ADD COLUMN IF NOT EXISTS sent_outside boolean DEFAULT false;

-- Add comment for clarity
COMMENT ON COLUMN lab_orders.sent_outside IS 'Indicates if the test was sent to an external/outside laboratory';
COMMENT ON COLUMN imaging_orders.sent_outside IS 'Indicates if the imaging was sent to an external/outside facility';