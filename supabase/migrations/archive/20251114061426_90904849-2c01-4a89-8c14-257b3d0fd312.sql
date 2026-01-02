-- Clean up orphaned tenants and facilities before creating super admin
DELETE FROM facilities WHERE clinic_code = 'SUPERADMIN';
DELETE FROM tenants WHERE name = 'System Administration';
