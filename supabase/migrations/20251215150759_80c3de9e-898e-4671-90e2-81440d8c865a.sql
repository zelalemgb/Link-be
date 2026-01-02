-- Delete feature requests for users not at Link Health Center
DELETE FROM feature_requests WHERE user_id IN (SELECT id FROM users WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33');