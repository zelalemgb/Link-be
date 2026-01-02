-- Create suppliers table
CREATE TABLE public.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  is_active BOOLEAN DEFAULT true,
  facility_id UUID REFERENCES public.facilities(id),
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create inventory_items table (drug catalog)
CREATE TABLE public.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  generic_name TEXT,
  dosage_form TEXT NOT NULL,
  strength TEXT,
  unit_of_measure TEXT NOT NULL DEFAULT 'units',
  category TEXT,
  reorder_level INTEGER DEFAULT 0,
  max_stock_level INTEGER,
  unit_cost NUMERIC(10,2),
  facility_id UUID REFERENCES public.facilities(id),
  is_active BOOLEAN DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create stock_movements table (all inventory transactions)
CREATE TABLE public.stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  movement_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  batch_number TEXT,
  expiry_date DATE,
  supplier_id UUID REFERENCES public.suppliers(id),
  reference_number TEXT,
  source_facility UUID REFERENCES public.facilities(id),
  destination_facility UUID REFERENCES public.facilities(id),
  facility_id UUID NOT NULL REFERENCES public.facilities(id),
  patient_id UUID REFERENCES public.patients(id),
  visit_id UUID REFERENCES public.visits(id),
  unit_cost NUMERIC(10,2),
  total_cost NUMERIC(10,2),
  notes TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create current_stock view
CREATE OR REPLACE VIEW public.current_stock AS
SELECT 
  i.id as inventory_item_id,
  i.name,
  i.generic_name,
  i.dosage_form,
  i.strength,
  i.unit_of_measure,
  i.reorder_level,
  i.facility_id,
  COALESCE(
    (SELECT SUM(
      CASE 
        WHEN movement_type IN ('receipt', 'transfer_in', 'adjustment') THEN quantity
        WHEN movement_type IN ('issue', 'transfer_out', 'expired', 'damaged') THEN -quantity
        ELSE 0
      END
    )
    FROM stock_movements sm
    WHERE sm.inventory_item_id = i.id AND sm.facility_id = i.facility_id
    ), 0
  ) as current_quantity,
  (SELECT MAX(created_at) FROM stock_movements sm WHERE sm.inventory_item_id = i.id) as last_movement_date
FROM inventory_items i
WHERE i.is_active = true;

-- Enable RLS
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

-- RLS Policies for suppliers
CREATE POLICY "Facility staff can view their suppliers"
  ON public.suppliers FOR SELECT
  USING (
    facility_id = get_user_facility_id() OR
    is_super_admin()
  );

CREATE POLICY "Logistic officers can manage suppliers"
  ON public.suppliers FOR ALL
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('logistic_officer', 'pharmacist', 'super_admin')
    )
  );

-- RLS Policies for inventory_items
CREATE POLICY "Facility staff can view inventory items"
  ON public.inventory_items FOR SELECT
  USING (
    facility_id = get_user_facility_id() OR
    is_super_admin()
  );

CREATE POLICY "Logistic officers can manage inventory items"
  ON public.inventory_items FOR ALL
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('logistic_officer', 'pharmacist', 'super_admin')
    )
  );

-- RLS Policies for stock_movements
CREATE POLICY "Facility staff can view stock movements"
  ON public.stock_movements FOR SELECT
  USING (
    facility_id = get_user_facility_id() OR
    is_super_admin()
  );

CREATE POLICY "Logistic officers and pharmacists can create movements"
  ON public.stock_movements FOR INSERT
  WITH CHECK (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('logistic_officer', 'pharmacist', 'super_admin')
    )
  );

CREATE POLICY "Logistic officers can update movements"
  ON public.stock_movements FOR UPDATE
  USING (
    facility_id = get_user_facility_id() AND
    EXISTS (
      SELECT 1 FROM users 
      WHERE auth_user_id = auth.uid() 
      AND user_role IN ('logistic_officer', 'super_admin')
    )
  );

-- Create indexes
CREATE INDEX idx_stock_movements_item ON public.stock_movements(inventory_item_id);
CREATE INDEX idx_stock_movements_facility ON public.stock_movements(facility_id);
CREATE INDEX idx_stock_movements_created_at ON public.stock_movements(created_at);
CREATE INDEX idx_inventory_items_facility ON public.inventory_items(facility_id);

-- Create triggers
CREATE TRIGGER update_suppliers_updated_at
  BEFORE UPDATE ON public.suppliers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_inventory_items_updated_at
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_stock_movements_updated_at
  BEFORE UPDATE ON public.stock_movements
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();