
-- Update the test lab technician to work at Haleluya Hospital where Mare Gezu's orders are
UPDATE users
SET facility_id = '5a10c953-6997-430c-9080-2a61ce422d64'
WHERE auth_user_id = '8bda92ee-17ee-479c-a8be-f1b46e56785b'
AND user_role = 'lab_technician';
