-- Update the visits table RLS policy to allow nurses to update vitals
DROP POLICY IF EXISTS "Users can update visits they created" ON public.visits;

-- Create a new policy that allows:
-- 1. Users to update visits they created (original functionality)
-- 2. Nurses to update any visit (for vital signs)
-- 3. Doctors to update any visit (for clinical notes)
CREATE POLICY "Users can update visits appropriately" ON public.visits
  FOR UPDATE
  USING (
    -- User created the visit
    (created_by IN (SELECT users.id FROM users WHERE users.auth_user_id = auth.uid()))
    OR
    -- User is a nurse (can update any visit for vitals)
    (EXISTS (SELECT 1 FROM users WHERE users.auth_user_id = auth.uid() AND users.user_role = 'nurse'))
    OR
    -- User is a doctor (can update any visit for clinical notes)
    (EXISTS (SELECT 1 FROM users WHERE users.auth_user_id = auth.uid() AND users.user_role = 'doctor'))
    OR
    -- User is a clinical officer (can update any visit)
    (EXISTS (SELECT 1 FROM users WHERE users.auth_user_id = auth.uid() AND users.user_role = 'clinical_officer'))
  );