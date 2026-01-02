-- Add tester status to facilities table
ALTER TABLE facilities 
ADD COLUMN IF NOT EXISTS is_tester BOOLEAN DEFAULT false;

-- Create staff invitations table
CREATE TABLE IF NOT EXISTS staff_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID REFERENCES facilities(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invitation_token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted BOOLEAN DEFAULT false,
  accepted_at TIMESTAMPTZ,
  invited_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on staff_invitations
ALTER TABLE staff_invitations ENABLE ROW LEVEL SECURITY;

-- Policy: Facility admin can view their facility's invitations
CREATE POLICY "Facility admin can view their invitations"
ON staff_invitations
FOR SELECT
TO authenticated
USING (
  facility_id IN (
    SELECT f.id FROM facilities f
    JOIN users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  )
);

-- Policy: Facility admin can create invitations
CREATE POLICY "Facility admin can create invitations"
ON staff_invitations
FOR INSERT
TO authenticated
WITH CHECK (
  facility_id IN (
    SELECT f.id FROM facilities f
    JOIN users u ON f.admin_user_id = u.id
    WHERE u.auth_user_id = auth.uid()
  )
);

-- Policy: Anyone can view their own invitation by token (for public access)
CREATE POLICY "Anyone can view invitation by token"
ON staff_invitations
FOR SELECT
TO anon, authenticated
USING (true);

-- Add index for faster token lookups
CREATE INDEX IF NOT EXISTS idx_staff_invitations_token ON staff_invitations(invitation_token);
CREATE INDEX IF NOT EXISTS idx_staff_invitations_facility ON staff_invitations(facility_id);

-- Add trigger for updated_at
CREATE TRIGGER update_staff_invitations_updated_at
BEFORE UPDATE ON staff_invitations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();