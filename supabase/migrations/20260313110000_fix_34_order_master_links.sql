-- Stabilize lab/medication orders against scoped master catalog overrides.
-- Orders now capture the resolved master row directly, while legacy callers
-- can still rely on database-side scoped resolution during insert/update.

ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS lab_test_master_id UUID REFERENCES public.lab_test_master(id);

ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS medication_master_id UUID REFERENCES public.medication_master(id);

CREATE INDEX IF NOT EXISTS idx_lab_orders_lab_test_master_id
  ON public.lab_orders(lab_test_master_id);

CREATE INDEX IF NOT EXISTS idx_medication_orders_medication_master_id
  ON public.medication_orders(medication_master_id);

CREATE OR REPLACE FUNCTION public.resolve_scoped_lab_test_master_id(
  p_tenant_id UUID,
  p_facility_id UUID,
  p_test_code TEXT,
  p_test_name TEXT
)
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT ltm.id
  FROM public.lab_test_master ltm
  WHERE ltm.tenant_id = p_tenant_id
    AND ltm.is_active IS DISTINCT FROM FALSE
    AND (ltm.facility_id = p_facility_id OR ltm.facility_id IS NULL)
    AND (
      (
        NULLIF(BTRIM(p_test_code), '') IS NOT NULL
        AND LOWER(ltm.test_code) = LOWER(BTRIM(p_test_code))
      )
      OR (
        NULLIF(BTRIM(p_test_name), '') IS NOT NULL
        AND LOWER(ltm.test_name) = LOWER(BTRIM(p_test_name))
      )
    )
  ORDER BY
    CASE WHEN p_facility_id IS NOT NULL AND ltm.facility_id = p_facility_id THEN 0 ELSE 1 END,
    CASE
      WHEN NULLIF(BTRIM(p_test_code), '') IS NOT NULL
        AND LOWER(ltm.test_code) = LOWER(BTRIM(p_test_code))
      THEN 0
      ELSE 1
    END,
    ltm.created_at DESC NULLS LAST,
    ltm.id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.resolve_scoped_medication_master_id(
  p_tenant_id UUID,
  p_facility_id UUID,
  p_medication_name TEXT,
  p_generic_name TEXT
)
RETURNS UUID
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT mm.id
  FROM public.medication_master mm
  WHERE mm.tenant_id = p_tenant_id
    AND mm.is_active IS DISTINCT FROM FALSE
    AND (mm.facility_id = p_facility_id OR mm.facility_id IS NULL)
    AND (
      (
        NULLIF(BTRIM(p_medication_name), '') IS NOT NULL
        AND (
          LOWER(mm.medication_name) = LOWER(BTRIM(p_medication_name))
          OR LOWER(COALESCE(mm.generic_name, '')) = LOWER(BTRIM(p_medication_name))
        )
      )
      OR (
        NULLIF(BTRIM(p_generic_name), '') IS NOT NULL
        AND (
          LOWER(mm.medication_name) = LOWER(BTRIM(p_generic_name))
          OR LOWER(COALESCE(mm.generic_name, '')) = LOWER(BTRIM(p_generic_name))
        )
      )
    )
  ORDER BY
    CASE WHEN p_facility_id IS NOT NULL AND mm.facility_id = p_facility_id THEN 0 ELSE 1 END,
    CASE
      WHEN NULLIF(BTRIM(p_medication_name), '') IS NOT NULL
        AND LOWER(mm.medication_name) = LOWER(BTRIM(p_medication_name))
      THEN 0
      ELSE 1
    END,
    CASE
      WHEN NULLIF(BTRIM(p_generic_name), '') IS NOT NULL
        AND LOWER(COALESCE(mm.generic_name, '')) = LOWER(BTRIM(p_generic_name))
      THEN 0
      ELSE 1
    END,
    mm.created_at DESC NULLS LAST,
    mm.id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.sync_lab_order_master_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_facility_id UUID;
  v_match RECORD;
BEGIN
  IF NEW.visit_id IS NULL OR NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT v.facility_id
  INTO v_facility_id
  FROM public.visits v
  WHERE v.id = NEW.visit_id;

  IF NEW.lab_test_master_id IS NOT NULL THEN
    SELECT
      ltm.id,
      ltm.test_code,
      ltm.test_name,
      COALESCE(ltm.reference_range_general, ltm.reference_range_male, ltm.reference_range_female) AS reference_range
    INTO v_match
    FROM public.lab_test_master ltm
    WHERE ltm.id = NEW.lab_test_master_id
      AND ltm.tenant_id = NEW.tenant_id
      AND (
        ltm.facility_id IS NULL
        OR (v_facility_id IS NOT NULL AND ltm.facility_id = v_facility_id)
      )
    LIMIT 1;

    IF v_match.id IS NULL THEN
      RAISE EXCEPTION 'Invalid lab test master selection';
    END IF;
  ELSE
    SELECT
      ltm.id,
      ltm.test_code,
      ltm.test_name,
      COALESCE(ltm.reference_range_general, ltm.reference_range_male, ltm.reference_range_female) AS reference_range
    INTO v_match
    FROM public.lab_test_master ltm
    WHERE ltm.id = public.resolve_scoped_lab_test_master_id(
      NEW.tenant_id,
      v_facility_id,
      NEW.test_code,
      NEW.test_name
    )
    LIMIT 1;
  END IF;

  IF v_match.id IS NOT NULL THEN
    NEW.lab_test_master_id := v_match.id;
    NEW.test_code := COALESCE(v_match.test_code, NEW.test_code);
    NEW.test_name := COALESCE(v_match.test_name, NEW.test_name);
    NEW.reference_range := COALESCE(NULLIF(BTRIM(NEW.reference_range), ''), v_match.reference_range);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_medication_order_master_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_visit_facility_id UUID;
  v_facility_id UUID;
  v_match RECORD;
BEGIN
  IF NEW.visit_id IS NULL OR NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT v.facility_id
  INTO v_visit_facility_id
  FROM public.visits v
  WHERE v.id = NEW.visit_id;

  v_facility_id := COALESCE(NEW.facility_id, v_visit_facility_id);
  NEW.facility_id := v_facility_id;

  IF NEW.medication_master_id IS NOT NULL THEN
    SELECT
      mm.id,
      mm.medication_name,
      mm.generic_name,
      mm.route
    INTO v_match
    FROM public.medication_master mm
    WHERE mm.id = NEW.medication_master_id
      AND mm.tenant_id = NEW.tenant_id
      AND (
        mm.facility_id IS NULL
        OR (v_facility_id IS NOT NULL AND mm.facility_id = v_facility_id)
      )
    LIMIT 1;

    IF v_match.id IS NULL THEN
      RAISE EXCEPTION 'Invalid medication master selection';
    END IF;
  ELSE
    SELECT
      mm.id,
      mm.medication_name,
      mm.generic_name,
      mm.route
    INTO v_match
    FROM public.medication_master mm
    WHERE mm.id = public.resolve_scoped_medication_master_id(
      NEW.tenant_id,
      v_facility_id,
      NEW.medication_name,
      NEW.generic_name
    )
    LIMIT 1;
  END IF;

  IF v_match.id IS NOT NULL THEN
    NEW.medication_master_id := v_match.id;
    NEW.medication_name := COALESCE(v_match.medication_name, NEW.medication_name);
    NEW.generic_name := COALESCE(v_match.generic_name, NULLIF(BTRIM(NEW.generic_name), ''));
    NEW.route := COALESCE(NULLIF(BTRIM(NEW.route), ''), v_match.route, NEW.route);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_lab_order_master_link ON public.lab_orders;
CREATE TRIGGER set_lab_order_master_link
  BEFORE INSERT OR UPDATE OF visit_id, tenant_id, test_code, test_name, reference_range, lab_test_master_id
  ON public.lab_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_lab_order_master_link();

DROP TRIGGER IF EXISTS set_medication_order_master_link ON public.medication_orders;
CREATE TRIGGER set_medication_order_master_link
  BEFORE INSERT OR UPDATE OF visit_id, tenant_id, facility_id, medication_name, generic_name, route, medication_master_id
  ON public.medication_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_medication_order_master_link();

UPDATE public.lab_orders lo
SET
  lab_test_master_id = resolved.id,
  test_code = COALESCE(resolved.test_code, lo.test_code),
  test_name = COALESCE(resolved.test_name, lo.test_name),
  reference_range = COALESCE(NULLIF(BTRIM(lo.reference_range), ''), resolved.reference_range)
FROM (
  SELECT
    lo_inner.id AS order_id,
    ltm.id,
    ltm.test_code,
    ltm.test_name,
    COALESCE(ltm.reference_range_general, ltm.reference_range_male, ltm.reference_range_female) AS reference_range
  FROM public.lab_orders lo_inner
  JOIN public.visits v ON v.id = lo_inner.visit_id
  JOIN public.lab_test_master ltm
    ON ltm.id = COALESCE(
      lo_inner.lab_test_master_id,
      public.resolve_scoped_lab_test_master_id(lo_inner.tenant_id, v.facility_id, lo_inner.test_code, lo_inner.test_name)
    )
) resolved
WHERE lo.id = resolved.order_id
  AND (
    lo.lab_test_master_id IS DISTINCT FROM resolved.id
    OR lo.test_code IS NULL
    OR lo.test_name IS NULL
    OR NULLIF(BTRIM(lo.reference_range), '') IS NULL
  );

UPDATE public.medication_orders mo
SET facility_id = COALESCE(mo.facility_id, v.facility_id)
FROM public.visits v
WHERE mo.visit_id = v.id
  AND mo.facility_id IS NULL;

UPDATE public.medication_orders mo
SET
  medication_master_id = resolved.id,
  medication_name = COALESCE(resolved.medication_name, mo.medication_name),
  generic_name = COALESCE(resolved.generic_name, NULLIF(BTRIM(mo.generic_name), '')),
  route = COALESCE(NULLIF(BTRIM(mo.route), ''), resolved.route, mo.route)
FROM (
  SELECT
    mo_inner.id AS order_id,
    mm.id,
    mm.medication_name,
    mm.generic_name,
    mm.route
  FROM public.medication_orders mo_inner
  JOIN public.visits v ON v.id = mo_inner.visit_id
  JOIN public.medication_master mm
    ON mm.id = COALESCE(
      mo_inner.medication_master_id,
      public.resolve_scoped_medication_master_id(
        mo_inner.tenant_id,
        COALESCE(mo_inner.facility_id, v.facility_id),
        mo_inner.medication_name,
        mo_inner.generic_name
      )
    )
) resolved
WHERE mo.id = resolved.order_id
  AND (
    mo.medication_master_id IS DISTINCT FROM resolved.id
    OR NULLIF(BTRIM(mo.generic_name), '') IS NULL
  );

CREATE OR REPLACE FUNCTION public.get_lab_orders_with_patient()
RETURNS TABLE(
  id uuid,
  visit_id uuid,
  patient_id uuid,
  ordered_by uuid,
  test_name text,
  test_code text,
  urgency text,
  status text,
  result text,
  result_value text,
  reference_range text,
  notes text,
  ordered_at timestamp with time zone,
  collected_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  payment_status text,
  payment_mode text,
  amount numeric,
  paid_at timestamp with time zone,
  patient_full_name text,
  patient_age integer,
  patient_gender text,
  sample_type text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    lo.id,
    lo.visit_id,
    lo.patient_id,
    lo.ordered_by,
    lo.test_name,
    lo.test_code,
    lo.urgency,
    lo.status,
    lo.result,
    lo.result_value,
    lo.reference_range,
    lo.notes,
    lo.ordered_at,
    lo.collected_at,
    lo.completed_at,
    lo.created_at,
    lo.updated_at,
    lo.payment_status,
    lo.payment_mode,
    lo.amount,
    lo.paid_at,
    p.full_name AS patient_full_name,
    p.age AS patient_age,
    p.gender AS patient_gender,
    COALESCE(ltm.sample_type, 'Serum') AS sample_type
  FROM public.lab_orders lo
  JOIN public.patients p ON p.id = lo.patient_id
  JOIN public.visits v ON v.id = lo.visit_id
  LEFT JOIN LATERAL (
    SELECT ltm_inner.*
    FROM public.lab_test_master ltm_inner
    WHERE ltm_inner.id = COALESCE(
      lo.lab_test_master_id,
      public.resolve_scoped_lab_test_master_id(lo.tenant_id, v.facility_id, lo.test_code, lo.test_name)
    )
    LIMIT 1
  ) ltm ON TRUE
  WHERE (
    v.facility_id = public.get_user_facility_id()
    OR public.is_super_admin()
  )
  ORDER BY lo.ordered_at DESC;
$$;
