
-- Link Receiving Invoice to Request
ALTER TABLE public.receiving_invoices
ADD COLUMN IF NOT EXISTS request_id UUID REFERENCES public.request_for_resupply(id);

-- Track requested quantity for fill rate analysis and validation
ALTER TABLE public.receiving_invoice_items
ADD COLUMN IF NOT EXISTS requested_quantity INTEGER DEFAULT 0;
