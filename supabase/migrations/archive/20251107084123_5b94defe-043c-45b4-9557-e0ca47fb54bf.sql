-- Drop the existing function
DROP FUNCTION IF EXISTS public.get_imaging_orders_with_patient();

-- Recreate the function to use tenant_id instead of facility_id
CREATE OR REPLACE FUNCTION public.get_imaging_orders_with_patient()
RETURNS TABLE (
  id uuid,
  visit_id uuid,
  patient_id uuid,
  study_name text,
  study_code text,
  body_part text,
  urgency text,
  status text,
  notes text,
  findings text,
  impression text,
  result text,
  ordered_at timestamptz,
  ordered_by uuid,
  completed_at timestamptz,
  scheduled_at timestamptz,
  payment_status text,
  paid_at timestamptz,
  amount numeric,
  payment_mode text,
  sent_outside boolean,
  created_at timestamptz,
  updated_at timestamptz,
  tenant_id uuid,
  visit_date date,
  reason text,
  patient_full_name text,
  patient_age integer,
  patient_gender text,
  patient_phone text
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
      io.id,
      io.visit_id,
      io.patient_id,
      io.study_name,
      io.study_code,
      io.body_part,
      io.urgency,
      io.status,
      io.notes,
      io.findings,
      io.impression,
      io.result,
      io.ordered_at,
      io.ordered_by,
      io.completed_at,
      io.scheduled_at,
      io.payment_status,
      io.paid_at,
      io.amount,
      io.payment_mode,
      io.sent_outside,
      io.created_at,
      io.updated_at,
      io.tenant_id,
      v.visit_date,
      v.reason,
      p.full_name,
      p.age,
      p.gender,
      p.phone
    FROM public.imaging_orders io
    LEFT JOIN public.visits v ON io.visit_id = v.id
    LEFT JOIN public.patients p ON io.patient_id = p.id
    WHERE io.payment_status = 'paid'
    ORDER BY io.created_at DESC;
  ELSE
    -- For regular users, filter by tenant_id
    RETURN QUERY
    SELECT 
      io.id,
      io.visit_id,
      io.patient_id,
      io.study_name,
      io.study_code,
      io.body_part,
      io.urgency,
      io.status,
      io.notes,
      io.findings,
      io.impression,
      io.result,
      io.ordered_at,
      io.ordered_by,
      io.completed_at,
      io.scheduled_at,
      io.payment_status,
      io.paid_at,
      io.amount,
      io.payment_mode,
      io.sent_outside,
      io.created_at,
      io.updated_at,
      io.tenant_id,
      v.visit_date,
      v.reason,
      p.full_name,
      p.age,
      p.gender,
      p.phone
    FROM public.imaging_orders io
    LEFT JOIN public.visits v ON io.visit_id = v.id
    LEFT JOIN public.patients p ON io.patient_id = p.id
    WHERE io.tenant_id = current_tenant_id
      AND io.payment_status = 'paid'
    ORDER BY io.created_at DESC;
  END IF;
END;
$$;