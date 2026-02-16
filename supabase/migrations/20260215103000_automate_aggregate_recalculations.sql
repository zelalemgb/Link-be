-- Canonical replacement for archived aggregate recalculation automation.
-- Keeps aggregate columns synchronized through deterministic trigger logic.

BEGIN;

ALTER TABLE public.inventory_accounts
  ADD COLUMN IF NOT EXISTS ending_balance NUMERIC(18,2) DEFAULT 0;

CREATE OR REPLACE FUNCTION public.recalculate_payment_totals(p_payment_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_total NUMERIC(18,2) := 0;
  v_paid NUMERIC(18,2) := 0;
  v_due NUMERIC(18,2) := 0;
  v_status public.payment_status_enum := 'pending';
BEGIN
  IF p_payment_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(final_amount), 0)
    INTO v_total
  FROM public.payment_line_items
  WHERE payment_id = p_payment_id;

  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    SELECT COALESCE(SUM(amount), 0)
      INTO v_paid
    FROM public.payment_transactions
    WHERE payment_id = p_payment_id;
  END IF;

  v_due := GREATEST(v_total - v_paid, 0);

  v_status := CASE
    WHEN v_total = 0 AND v_paid = 0 THEN 'pending'
    WHEN v_due = 0 THEN 'paid'
    WHEN v_paid > 0 THEN 'partial'
    ELSE 'pending'
  END;

  UPDATE public.payments
  SET total_amount = v_total,
      amount_paid = v_paid,
      amount_due = v_due,
      payment_status = v_status,
      updated_at = now()
  WHERE id = p_payment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_inventory_balances(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC(18,2) := 0;
  v_column TEXT;
  v_sql TEXT;
BEGIN
  IF p_account_id IS NULL THEN
    RETURN;
  END IF;

  IF to_regclass('public.inventory_transactions') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_transactions'
      AND column_name = 'account_id'
  ) THEN
    RETURN;
  END IF;

  SELECT column_name
    INTO v_column
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'inventory_transactions'
    AND column_name IN (
      'value_delta', 'amount_delta', 'balance_delta', 'quantity_delta',
      'delta_value', 'delta_amount', 'net_change', 'change_amount', 'change_value'
    )
  ORDER BY CASE column_name
    WHEN 'value_delta' THEN 1
    WHEN 'amount_delta' THEN 2
    WHEN 'balance_delta' THEN 3
    WHEN 'quantity_delta' THEN 4
    WHEN 'delta_value' THEN 5
    WHEN 'delta_amount' THEN 6
    WHEN 'net_change' THEN 7
    WHEN 'change_amount' THEN 8
    WHEN 'change_value' THEN 9
    ELSE 10
  END
  LIMIT 1;

  IF v_column IS NULL THEN
    SELECT column_name
      INTO v_column
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_transactions'
      AND data_type IN ('numeric', 'double precision', 'real', 'integer', 'bigint')
      AND column_name NOT IN (
        'account_id', 'id', 'created_at', 'updated_at', 'tenant_id', 'facility_id',
        'inventory_item_id', 'reference_id', 'user_id'
      )
    ORDER BY ordinal_position
    LIMIT 1;
  END IF;

  IF v_column IS NULL THEN
    RETURN;
  END IF;

  v_sql := format(
    'SELECT COALESCE(SUM(%I), 0) FROM public.inventory_transactions WHERE account_id = $1',
    v_column
  );

  EXECUTE v_sql INTO v_balance USING p_account_id;

  UPDATE public.inventory_accounts
  SET ending_balance = v_balance,
      updated_at = now()
  WHERE id = p_account_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_bed_utilization(p_ward_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_total INTEGER := NULL;
  v_cleaning INTEGER := 0;
  v_occupied INTEGER := 0;
  v_available INTEGER := 0;
BEGIN
  IF p_ward_id IS NULL THEN
    RETURN;
  END IF;

  IF to_regclass('public.beds') IS NOT NULL THEN
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE UPPER(status) = 'CLEANING')
      INTO v_total, v_cleaning
    FROM public.beds
    WHERE ward_id = p_ward_id;
  END IF;

  IF to_regclass('public.patient_bed_assignments') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'patient_bed_assignments'
        AND column_name = 'released_at'
    ) THEN
      SELECT COUNT(*)
        INTO v_occupied
      FROM public.patient_bed_assignments
      WHERE ward_id = p_ward_id
        AND released_at IS NULL;
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'patient_bed_assignments'
        AND column_name = 'ended_at'
    ) THEN
      SELECT COUNT(*)
        INTO v_occupied
      FROM public.patient_bed_assignments
      WHERE ward_id = p_ward_id
        AND ended_at IS NULL;
    ELSE
      SELECT COUNT(*)
        INTO v_occupied
      FROM public.patient_bed_assignments
      WHERE ward_id = p_ward_id;
    END IF;
  END IF;

  v_available := GREATEST(COALESCE(v_total, 0) - v_occupied - v_cleaning, 0);

  UPDATE public.wards
  SET total_beds = COALESCE(v_total, total_beds),
      occupied_beds = v_occupied,
      cleaning_beds = v_cleaning,
      available_beds = v_available,
      updated_at = now()
  WHERE id = p_ward_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_payment_totals_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment_id uuid;
BEGIN
  v_payment_id := COALESCE(NEW.payment_id, OLD.payment_id);
  PERFORM public.recalculate_payment_totals(v_payment_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_inventory_balances_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id uuid;
BEGIN
  v_account_id := COALESCE(NEW.account_id, OLD.account_id);
  PERFORM public.refresh_inventory_balances(v_account_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_bed_utilization_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ward_id uuid;
BEGIN
  v_ward_id := COALESCE(NEW.ward_id, OLD.ward_id);
  PERFORM public.update_bed_utilization(v_ward_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.payment_line_items') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_recalculate_payment_totals ON public.payment_line_items';
    EXECUTE 'CREATE TRIGGER trg_recalculate_payment_totals
      AFTER INSERT OR UPDATE OR DELETE ON public.payment_line_items
      FOR EACH ROW EXECUTE FUNCTION public.recalculate_payment_totals_trigger()';
  END IF;

  IF to_regclass('public.payment_transactions') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_recalculate_payment_totals_txn ON public.payment_transactions';
    EXECUTE 'CREATE TRIGGER trg_recalculate_payment_totals_txn
      AFTER INSERT OR UPDATE OR DELETE ON public.payment_transactions
      FOR EACH ROW EXECUTE FUNCTION public.recalculate_payment_totals_trigger()';
  END IF;

  IF to_regclass('public.inventory_transactions') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_refresh_inventory_balances ON public.inventory_transactions';
    EXECUTE '' ||
      'CREATE TRIGGER trg_refresh_inventory_balances '
      || 'AFTER INSERT OR UPDATE OR DELETE ON public.inventory_transactions '
      || 'FOR EACH ROW EXECUTE FUNCTION public.refresh_inventory_balances_trigger()';
  END IF;

  IF to_regclass('public.patient_bed_assignments') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_update_bed_utilization ON public.patient_bed_assignments';
    EXECUTE 'CREATE TRIGGER trg_update_bed_utilization
      AFTER INSERT OR UPDATE OR DELETE ON public.patient_bed_assignments
      FOR EACH ROW EXECUTE FUNCTION public.update_bed_utilization_trigger()';
  END IF;
END;
$$;

COMMIT;
