-- Create a test clinic for testing purposes
INSERT INTO public.facilities (
  name, 
  location, 
  address, 
  phone_number, 
  email, 
  verification_status,
  verified,
  clinic_code
) VALUES (
  'Test Medical Clinic',
  'Addis Ababa',
  '123 Test Street, Addis Ababa, Ethiopia',
  '+251911123456',
  'test@clinic.com',
  'pending',
  false,
  'TE12A3'
) RETURNING id, clinic_code;