
-- Update check_duplicate_facility to prevent duplicates at registration time
-- Previously only checked against verified=true facilities

CREATE OR REPLACE FUNCTION check_duplicate_facility()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if a facility with the same normalized name and location already exists
  -- Now checks ALL facilities (pending or verified), not just verified ones
  IF EXISTS (
    SELECT 1 
    FROM facilities 
    WHERE normalize_facility_name(name) = normalize_facility_name(NEW.name)
    AND (
      -- Same location
      (location IS NOT NULL AND NEW.location IS NOT NULL AND normalize_facility_name(location) = normalize_facility_name(NEW.location))
      OR
      -- Same phone number (strong indicator of duplicate)
      (phone_number IS NOT NULL AND NEW.phone_number IS NOT NULL AND phone_number = NEW.phone_number)
    )
    AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    -- Removed: AND verified = true
    -- Now blocks duplicates at registration time, not just approval time
  ) THEN
    RAISE EXCEPTION 'A facility with this name and location already exists. Please check existing facilities or contact support.';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Also clean up the duplicate pending registration
DELETE FROM facilities WHERE id = 'be39ca18-8923-4d33-a317-1dd0472ff9cc';
