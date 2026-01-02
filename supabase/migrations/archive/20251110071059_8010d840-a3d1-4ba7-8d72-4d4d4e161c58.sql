-- Add unique constraint to prevent duplicate facility assignments
ALTER TABLE users 
ADD CONSTRAINT unique_user_facility 
UNIQUE (auth_user_id, facility_id);

-- Add index for faster facility lookups
CREATE INDEX IF NOT EXISTS idx_users_auth_facilities 
ON users(auth_user_id, facility_id);

-- Add index for tenant + facility lookups
CREATE INDEX IF NOT EXISTS idx_users_tenant_facility
ON users(tenant_id, facility_id);

COMMENT ON CONSTRAINT unique_user_facility ON users IS 
'Ensures a user can only be assigned to a facility once, but allows same user across multiple facilities';