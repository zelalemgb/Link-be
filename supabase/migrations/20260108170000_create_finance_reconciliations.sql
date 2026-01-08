CREATE TABLE IF NOT EXISTS public.finance_reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id),
    cashier_id UUID NOT NULL REFERENCES public.users(id),
    expected_total DECIMAL(10, 2) NOT NULL DEFAULT 0,
    cash_collected DECIMAL(10, 2) NOT NULL DEFAULT 0,
    digital_collected DECIMAL(10, 2) NOT NULL DEFAULT 0,
    variance DECIMAL(10, 2) NOT NULL DEFAULT 0,
    reason TEXT CHECK (reason IN ('Change', 'Waiver', 'Error', 'Pending')),
    notes TEXT,
    reconciled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.finance_reconciliations ENABLE ROW LEVEL SECURITY;

-- Policies

-- Allow viewing reconciliations for the user's facility
DROP POLICY IF EXISTS "Staff can view facility reconciliations" ON public.finance_reconciliations;
CREATE POLICY "Staff can view facility reconciliations"
ON public.finance_reconciliations
FOR SELECT
USING (
    facility_id = public.get_user_facility_id()
    OR
    (SELECT is_super_admin())
);

-- Allow Cashier/Finance to insert (usually done via API with service role, but for completeness)
DROP POLICY IF EXISTS "Cashier can insert own reconciliations" ON public.finance_reconciliations;
CREATE POLICY "Cashier can insert own reconciliations"
ON public.finance_reconciliations
FOR INSERT
WITH CHECK (
    cashier_id IN (
        SELECT id FROM public.users WHERE auth_user_id = auth.uid()
    )
);
