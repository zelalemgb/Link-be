
-- Ensure proper linkage between Receiving (GRN) and Request (RRF)
-- This migration is idempotent (safe to run multiple times)

-- 1. Add request_id to receiving_invoices if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'receiving_invoices' AND column_name = 'request_id') THEN 
        ALTER TABLE public.receiving_invoices 
        ADD COLUMN request_id UUID REFERENCES public.request_for_resupply(id);
    END IF; 
END $$;

-- 2. Add requested_quantity to receiving_invoice_items if it doesn't exist
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'receiving_invoice_items' AND column_name = 'requested_quantity') THEN 
        ALTER TABLE public.receiving_invoice_items 
        ADD COLUMN requested_quantity INTEGER DEFAULT 0;
    END IF; 
END $$;
