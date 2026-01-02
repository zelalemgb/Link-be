-- Delete master data for non-Link facilities
DELETE FROM medical_services WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';
DELETE FROM programs WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';
DELETE FROM insurers WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';
DELETE FROM creditors WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';
DELETE FROM departments WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';
DELETE FROM inventory_items WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';