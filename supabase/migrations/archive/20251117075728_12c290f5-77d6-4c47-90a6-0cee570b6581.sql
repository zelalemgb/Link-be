-- Step 1: Delete 2 of the 3 duplicate Hanu Medical Center facilities
-- Keep the oldest one (c3415471-67aa-45f3-bee0-daf6c39f55b7)
-- Delete the other two
DELETE FROM facilities 
WHERE id IN (
  'cf8841ff-f034-41b5-96bd-ac63a54101bc',
  'c45d3fec-2c7a-4891-9660-18db86f75e0d'
);

-- Step 2: Create a function to normalize facility names for duplicate checking
CREATE OR REPLACE FUNCTION normalize_facility_name(name text)
RETURNS text AS $$
BEGIN
  -- Remove extra spaces, convert to lowercase for comparison
  RETURN lower(trim(regexp_replace(name, '\s+', ' ', 'g')));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Step 3: Create index for efficient duplicate checking
CREATE INDEX IF NOT EXISTS idx_facilities_normalized_name 
ON facilities (normalize_facility_name(name), location);

-- Step 4: Add trigger to prevent duplicate facilities
CREATE OR REPLACE FUNCTION check_duplicate_facility()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if a facility with the same normalized name and location already exists
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
    AND verified = true
  ) THEN
    RAISE EXCEPTION 'A facility with this name and location already exists. Please check existing facilities or contact support.';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS prevent_duplicate_facilities ON facilities;
CREATE TRIGGER prevent_duplicate_facilities
  BEFORE INSERT OR UPDATE ON facilities
  FOR EACH ROW
  EXECUTE FUNCTION check_duplicate_facility();

-- Step 5: Add comment to document the duplicate prevention logic
COMMENT ON FUNCTION check_duplicate_facility() IS 
'Prevents duplicate facility entries by checking normalized name + location or name + phone number combinations';
