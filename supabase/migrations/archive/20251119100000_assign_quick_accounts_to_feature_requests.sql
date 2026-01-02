-- Associate existing feature requests with quick testing accounts
DO $$
DECLARE
  mapping RECORD;
BEGIN
  FOR mapping IN
    SELECT * FROM (VALUES
      ('CLINIC_REGISTRATION', 'admin@gmail.com'),
      ('RECEPTION_INTAKE', 'receptionist@gmail.com'),
      ('NURSE_TRIAGE', 'nurse@gmail.com'),
      ('DOCTOR_ASSESSMENT', 'doctor@gmail.com'),
      ('LAB_TESTING', 'lab@gmail.com'),
      ('PHARMACY_DISPENSING', 'pharmacy@gmail.com'),
      ('IMAGING_ORDERS', 'imaging@gmail.com'),
      ('CASHIER_BILLING', 'cashier@gmail.com'),
      ('INVENTORY_MANAGEMENT', 'logistic@gmail.com'),
      ('ANC_ASSESSMENT', 'nursing-head@gmail.com')
    ) AS t(form_type, email)
  LOOP
    UPDATE public.feature_requests fr
    SET
      user_id = u.id,
      facility_id = COALESCE(fr.facility_id, u.facility_id),
      updated_at = now()
    FROM public.users u
    JOIN auth.users au ON au.id = u.auth_user_id
    WHERE fr.form_type = mapping.form_type
      AND fr.user_id IS NULL
      AND au.email = mapping.email;
  END LOOP;
END $$;
