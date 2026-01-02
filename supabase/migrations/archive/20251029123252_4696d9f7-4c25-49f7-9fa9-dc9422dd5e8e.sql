-- Fix lab_orders status constraint to allow 'in_progress' status
-- Drop the old constraint
ALTER TABLE lab_orders DROP CONSTRAINT IF EXISTS lab_orders_status_check;

-- Add new constraint with 'in_progress' status
ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_status_check 
  CHECK (status IN ('pending', 'collected', 'in_progress', 'completed', 'cancelled'));

-- Ensure lab_orders results are properly indexed for patient medical record queries
CREATE INDEX IF NOT EXISTS idx_lab_orders_patient_completed 
  ON lab_orders(patient_id, completed_at DESC) 
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_lab_orders_visit 
  ON lab_orders(visit_id, status);

-- Add comment for clarity
COMMENT ON COLUMN lab_orders.status IS 'Status of lab order: pending, collected, in_progress (results entered but not released), completed (results released), cancelled';