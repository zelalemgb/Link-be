-- Update cashier user to have facility_id so they can see visits
UPDATE users 
SET facility_id = '5a10c953-6997-430c-9080-2a61ce422d64'
WHERE auth_user_id = 'f2777d80-94cc-471a-9196-f7f23b9a7ed9';