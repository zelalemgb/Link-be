-- Create inventory accounts table
CREATE TABLE public.inventory_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_code TEXT NOT NULL UNIQUE,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL, -- 'RDF', 'Health Program', 'Other'
  is_active BOOLEAN DEFAULT true,
  facility_id UUID REFERENCES public.facilities(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create dispensing units table
CREATE TABLE public.dispensing_units (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  unit_name TEXT NOT NULL,
  unit_code TEXT,
  unit_type TEXT, -- 'OPD', 'Pharmacy', 'Ward', 'Lab', etc.
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create request for resupply (RRF) table
CREATE TABLE public.request_for_resupply (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  reference_no TEXT UNIQUE,
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  reporting_period TEXT NOT NULL, -- 'YYYY-MM' format
  account_id UUID REFERENCES public.inventory_accounts(id),
  account_type TEXT NOT NULL, -- 'RDF', 'Health Program'
  request_type TEXT NOT NULL, -- 'Emergency', 'Regular'
  request_to TEXT, -- 'EPSA Hub', 'PFSA'
  generated_by UUID NOT NULL REFERENCES public.users(id),
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'submitted', 'verified', 'approved', 'cancelled'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  submitted_at TIMESTAMP WITH TIME ZONE,
  verified_at TIMESTAMP WITH TIME ZONE,
  approved_at TIMESTAMP WITH TIME ZONE,
  verifier_id UUID REFERENCES public.users(id),
  approver_id UUID REFERENCES public.users(id),
  print_epp BOOLEAN DEFAULT false,
  notes TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create request line items table
CREATE TABLE public.request_line_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES public.request_for_resupply(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  quantity_requested INTEGER NOT NULL,
  amc INTEGER, -- Average Monthly Consumption
  soh INTEGER, -- Stock on Hand
  max_stock INTEGER,
  unit_cost NUMERIC(10,2),
  total_cost NUMERIC(10,2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create issue orders table (Model 22 Voucher)
CREATE TABLE public.issue_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  voucher_no TEXT UNIQUE,
  account_id UUID REFERENCES public.inventory_accounts(id),
  dispensing_unit_id UUID REFERENCES public.dispensing_units(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  period TEXT NOT NULL, -- 'YYYY-MM' format
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'pending', 'issued', 'cancelled'
  issued_by UUID REFERENCES public.users(id),
  issued_to UUID REFERENCES public.users(id),
  created_by UUID NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  issued_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create issue order items table
CREATE TABLE public.issue_order_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES public.issue_orders(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  beginning_balance INTEGER DEFAULT 0,
  qty_received INTEGER DEFAULT 0,
  loss INTEGER DEFAULT 0,
  adjustment INTEGER DEFAULT 0,
  ending_balance INTEGER, -- Calculated: beginning + received - loss + adjustment
  soh INTEGER, -- Stock on Hand
  max_level INTEGER,
  qty_requested INTEGER NOT NULL,
  qty_issued INTEGER DEFAULT 0,
  batch_no TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create receiving invoices table (Model 19)
CREATE TABLE public.receiving_invoices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_no TEXT UNIQUE NOT NULL,
  receive_date DATE NOT NULL,
  receive_type TEXT NOT NULL, -- 'Purchase', 'Transfer', 'Donation', 'Return'
  supplier_id UUID REFERENCES public.suppliers(id),
  account_id UUID REFERENCES public.inventory_accounts(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'submitted', 'invoiced', 'cancelled', 'voided'
  fulfillment_percentage NUMERIC(5,2),
  delivery_note_no TEXT,
  goods_receiving_note_no TEXT,
  created_by UUID NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  submitted_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create receiving invoice items table
CREATE TABLE public.receiving_invoice_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES public.receiving_invoices(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  batch_no TEXT NOT NULL,
  manufacturer TEXT,
  expiry_date DATE,
  unit_cost NUMERIC(10,2) NOT NULL,
  quantity INTEGER NOT NULL,
  unit_selling_price NUMERIC(10,2),
  profit_margin NUMERIC(5,2), -- Calculated: (selling - cost) / cost * 100
  store_location TEXT,
  storage_requirement TEXT, -- 'freezer', 'refrigerated', 'room_temp'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create loss adjustments table
CREATE TABLE public.loss_adjustments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id TEXT UNIQUE,
  account_id UUID REFERENCES public.inventory_accounts(id),
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  batch_no TEXT,
  soh INTEGER, -- Stock on Hand before adjustment
  reason TEXT NOT NULL, -- 'damage', 'expiry', 'theft', 'reconciliation', 'other'
  quantity INTEGER NOT NULL,
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'submitted', 'approved', 'rejected'
  created_by UUID NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  approved_by UUID REFERENCES public.users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Add new columns to inventory_items table
ALTER TABLE public.inventory_items 
ADD COLUMN IF NOT EXISTS manufacturer TEXT,
ADD COLUMN IF NOT EXISTS product_code TEXT,
ADD COLUMN IF NOT EXISTS amc INTEGER DEFAULT 0, -- Average Monthly Consumption
ADD COLUMN IF NOT EXISTS max_stock_level INTEGER,
ADD COLUMN IF NOT EXISTS storage_requirement TEXT DEFAULT 'room_temp'; -- 'freezer', 'refrigerated', 'room_temp'

-- Add new columns to stock_movements table
ALTER TABLE public.stock_movements
ADD COLUMN IF NOT EXISTS warehouse_location TEXT,
ADD COLUMN IF NOT EXISTS storage_condition TEXT;

-- Create indexes for better query performance
CREATE INDEX idx_request_line_items_request_id ON public.request_line_items(request_id);
CREATE INDEX idx_request_line_items_inventory_item_id ON public.request_line_items(inventory_item_id);
CREATE INDEX idx_issue_order_items_order_id ON public.issue_order_items(order_id);
CREATE INDEX idx_issue_order_items_inventory_item_id ON public.issue_order_items(inventory_item_id);
CREATE INDEX idx_receiving_invoice_items_invoice_id ON public.receiving_invoice_items(invoice_id);
CREATE INDEX idx_receiving_invoice_items_inventory_item_id ON public.receiving_invoice_items(inventory_item_id);
CREATE INDEX idx_loss_adjustments_inventory_item_id ON public.loss_adjustments(inventory_item_id);
CREATE INDEX idx_request_for_resupply_status ON public.request_for_resupply(status);
CREATE INDEX idx_issue_orders_status ON public.issue_orders(status);
CREATE INDEX idx_receiving_invoices_status ON public.receiving_invoices(status);
CREATE INDEX idx_loss_adjustments_status ON public.loss_adjustments(status);

-- Enable RLS on all new tables
ALTER TABLE public.inventory_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispensing_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_for_resupply ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issue_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receiving_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receiving_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loss_adjustments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for inventory_accounts
CREATE POLICY "Facility staff can view their accounts"
  ON public.inventory_accounts FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Logistic officers can manage accounts"
  ON public.inventory_accounts FOR ALL
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

-- RLS Policies for dispensing_units
CREATE POLICY "Facility staff can view their units"
  ON public.dispensing_units FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Logistic officers can manage units"
  ON public.dispensing_units FOR ALL
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

-- RLS Policies for request_for_resupply
CREATE POLICY "Facility staff can view their requests"
  ON public.request_for_resupply FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Logistic officers can create and edit requests"
  ON public.request_for_resupply FOR ALL
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

-- RLS Policies for request_line_items
CREATE POLICY "Users can view request line items"
  ON public.request_line_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.request_for_resupply
      WHERE id = request_line_items.request_id
      AND (facility_id = get_user_facility_id() OR is_super_admin())
    )
  );

CREATE POLICY "Users can manage request line items"
  ON public.request_line_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.request_for_resupply
      WHERE id = request_line_items.request_id
      AND facility_id = get_user_facility_id()
      AND EXISTS (
        SELECT 1 FROM public.users
        WHERE auth_user_id = auth.uid()
        AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
      )
    )
  );

-- RLS Policies for issue_orders
CREATE POLICY "Facility staff can view their issue orders"
  ON public.issue_orders FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Logistic officers can manage issue orders"
  ON public.issue_orders FOR ALL
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

-- RLS Policies for issue_order_items
CREATE POLICY "Users can view issue order items"
  ON public.issue_order_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.issue_orders
      WHERE id = issue_order_items.order_id
      AND (facility_id = get_user_facility_id() OR is_super_admin())
    )
  );

CREATE POLICY "Users can manage issue order items"
  ON public.issue_order_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.issue_orders
      WHERE id = issue_order_items.order_id
      AND facility_id = get_user_facility_id()
      AND EXISTS (
        SELECT 1 FROM public.users
        WHERE auth_user_id = auth.uid()
        AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
      )
    )
  );

-- RLS Policies for receiving_invoices
CREATE POLICY "Facility staff can view their receiving invoices"
  ON public.receiving_invoices FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Logistic officers can manage receiving invoices"
  ON public.receiving_invoices FOR ALL
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

-- RLS Policies for receiving_invoice_items
CREATE POLICY "Users can view receiving invoice items"
  ON public.receiving_invoice_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.receiving_invoices
      WHERE id = receiving_invoice_items.invoice_id
      AND (facility_id = get_user_facility_id() OR is_super_admin())
    )
  );

CREATE POLICY "Users can manage receiving invoice items"
  ON public.receiving_invoice_items FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.receiving_invoices
      WHERE id = receiving_invoice_items.invoice_id
      AND facility_id = get_user_facility_id()
      AND EXISTS (
        SELECT 1 FROM public.users
        WHERE auth_user_id = auth.uid()
        AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
      )
    )
  );

-- RLS Policies for loss_adjustments
CREATE POLICY "Facility staff can view their loss adjustments"
  ON public.loss_adjustments FOR SELECT
  USING (facility_id = get_user_facility_id() OR is_super_admin());

CREATE POLICY "Logistic officers can create and edit loss adjustments"
  ON public.loss_adjustments FOR ALL
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM public.users
      WHERE auth_user_id = auth.uid()
      AND user_role IN ('logistic_officer', 'pharmacist', 'admin', 'super_admin')
    )
  );

-- Add triggers for updated_at
CREATE TRIGGER update_inventory_accounts_updated_at BEFORE UPDATE ON public.inventory_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_dispensing_units_updated_at BEFORE UPDATE ON public.dispensing_units
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_request_for_resupply_updated_at BEFORE UPDATE ON public.request_for_resupply
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_issue_orders_updated_at BEFORE UPDATE ON public.issue_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_receiving_invoices_updated_at BEFORE UPDATE ON public.receiving_invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_loss_adjustments_updated_at BEFORE UPDATE ON public.loss_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();