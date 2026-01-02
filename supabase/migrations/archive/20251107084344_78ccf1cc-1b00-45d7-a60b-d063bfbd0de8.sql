-- Drop the existing function if it exists
DROP FUNCTION IF EXISTS public.get_medication_orders_with_patient();

-- Create the function to use tenant_id instead of facility_id
CREATE OR REPLACE FUNCTION public.get_medication_orders_with_patient()
RETURNS TABLE (
  id uuid,
  visit_id uuid,
  patient_id uuid,
  ordered_by uuid,
  medication_name text,
  generic_name text,
  dosage text,
  frequency text,
  route text,
  duration text,
  quantity integer,
  refills integer,
  status text,
  notes text,
  ordered_at timestamptz,
  dispensed_at timestamptz,
  patient_full_name text,
  patient_age integer,
  patient_gender text,
  prescriber_name text,
  payment_status text,
  payment_mode text,
  amount numeric,
  paid_at timestamptz,
  sent_outside boolean,
  created_at timestamptz,
  updated_at timestamptz,
  tenant_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_tenant_id uuid;
  is_super_admin boolean;
BEGIN
  -- Get the current user's tenant_id
  SELECT u.tenant_id, COALESCE(u.user_role = 'super_admin', false)
  INTO current_tenant_id, is_super_admin
  FROM public.users u
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1;

  -- If super admin, return all orders
  IF is_super_admin THEN
    RETURN QUERY
    SELECT 
      mo.id,
      mo.visit_id,
      mo.patient_id,
      mo.ordered_by,
      mo.medication_name,
      mo.generic_name,
      mo.dosage,
      mo.frequency,
      mo.route,
      mo.duration,
      mo.quantity,
      mo.refills,
      mo.status,
      mo.notes,
      mo.ordered_at,
      mo.dispensed_at,
      p.full_name,
      p.age,
      p.gender,
      u.name as prescriber_name,
      mo.payment_status,
      mo.payment_mode,
      mo.amount,
      mo.paid_at,
      mo.sent_outside,
      mo.created_at,
      mo.updated_at,
      mo.tenant_id
    FROM public.medication_orders mo
    LEFT JOIN public.patients p ON mo.patient_id = p.id
    LEFT JOIN public.users u ON mo.ordered_by = u.id
    WHERE mo.payment_status = 'paid'
    ORDER BY mo.created_at DESC;
  ELSE
    -- For regular users, filter by tenant_id
    RETURN QUERY
    SELECT 
      mo.id,
      mo.visit_id,
      mo.patient_id,
      mo.ordered_by,
      mo.medication_name,
      mo.generic_name,
      mo.dosage,
      mo.frequency,
      mo.route,
      mo.duration,
      mo.quantity,
      mo.refills,
      mo.status,
      mo.notes,
      mo.ordered_at,
      mo.dispensed_at,
      p.full_name,
      p.age,
      p.gender,
      u.name as prescriber_name,
      mo.payment_status,
      mo.payment_mode,
      mo.amount,
      mo.paid_at,
      mo.sent_outside,
      mo.created_at,
      mo.updated_at,
      mo.tenant_id
    FROM public.medication_orders mo
    LEFT JOIN public.patients p ON mo.patient_id = p.id
    LEFT JOIN public.users u ON mo.ordered_by = u.id
    WHERE mo.tenant_id = current_tenant_id
      AND mo.payment_status = 'paid'
    ORDER BY mo.created_at DESC;
  END IF;
END;
$$;