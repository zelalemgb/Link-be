-- Recommended RLS Policies

-- Users Table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile"
ON users FOR SELECT
USING (auth.uid() = auth_user_id);

CREATE POLICY "Users can update their own profile"
ON users FOR UPDATE
USING (auth.uid() = auth_user_id);

-- Facilities Table
ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Facilities are viewable by authenticated users"
ON facilities FOR SELECT
TO authenticated
USING (true);

-- Patient Accounts Table
ALTER TABLE patient_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Patients can view their own account"
ON patient_accounts FOR SELECT
USING (auth.uid() = auth_user_id); -- Assuming auth_user_id links to Supabase Auth

CREATE POLICY "Patients can update their own account"
ON patient_accounts FOR UPDATE
USING (auth.uid() = auth_user_id);

-- Staff Registration Requests
ALTER TABLE staff_registration_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own requests"
ON staff_registration_requests FOR SELECT
USING (auth.uid() = auth_user_id);

CREATE POLICY "Users can create requests"
ON staff_registration_requests FOR INSERT
WITH CHECK (auth.uid() = auth_user_id);
