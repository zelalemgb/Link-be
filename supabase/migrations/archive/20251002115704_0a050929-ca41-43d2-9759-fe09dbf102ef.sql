-- Add foreign key constraint from lab_orders to visits
ALTER TABLE lab_orders 
ADD CONSTRAINT lab_orders_visit_id_fkey 
FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;

-- Add foreign key constraint from imaging_orders to visits (if not exists)
ALTER TABLE imaging_orders 
ADD CONSTRAINT imaging_orders_visit_id_fkey 
FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;

-- Add foreign key constraint from medication_orders to visits (if not exists)
ALTER TABLE medication_orders 
ADD CONSTRAINT medication_orders_visit_id_fkey 
FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;