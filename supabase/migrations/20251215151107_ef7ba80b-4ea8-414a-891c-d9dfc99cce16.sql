-- Delete clinic registrations and facilities
DELETE FROM clinic_registrations WHERE facility_id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';
DELETE FROM facilities WHERE id != '8b0f0d07-7b81-4b4f-a570-e59f971fbd33';