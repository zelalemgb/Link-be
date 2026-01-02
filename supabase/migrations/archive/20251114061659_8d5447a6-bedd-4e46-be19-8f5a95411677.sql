-- Delete all facilities and tenants to start fresh
DELETE FROM facilities WHERE clinic_code = 'SUPERADMIN';
DELETE FROM tenants WHERE name = 'System Administration';