-- Add payment_status column to billing_items table
ALTER TABLE public.billing_items 
ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid';

-- Add payment_mode column for consistency with other order tables
ALTER TABLE public.billing_items 
ADD COLUMN payment_mode text;

-- Add paid_at timestamp for tracking when payment was made
ALTER TABLE public.billing_items 
ADD COLUMN paid_at timestamp with time zone;