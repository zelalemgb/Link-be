-- Add follow-up pricing columns to medical_services table
ALTER TABLE medical_services 
ADD COLUMN follow_up_price numeric,
ADD COLUMN follow_up_days integer DEFAULT 7;

COMMENT ON COLUMN medical_services.follow_up_price IS 'Reduced consultation fee for returning patients within follow_up_days';
COMMENT ON COLUMN medical_services.follow_up_days IS 'Number of days within which a patient is considered a returning patient';