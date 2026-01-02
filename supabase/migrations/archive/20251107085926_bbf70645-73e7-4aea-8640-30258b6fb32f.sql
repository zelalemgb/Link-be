-- Create index on users.auth_user_id for faster login queries
CREATE INDEX IF NOT EXISTS idx_users_auth_user_id ON public.users(auth_user_id);

-- Create index on patient_accounts.phone_number for faster patient login
CREATE INDEX IF NOT EXISTS idx_patient_accounts_phone_number ON public.patient_accounts(phone_number);