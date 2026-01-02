-- Add 'doctor' and 'clinical_officer' roles to the user_role enum
ALTER TYPE user_role ADD VALUE 'doctor';
ALTER TYPE user_role ADD VALUE 'clinical_officer';