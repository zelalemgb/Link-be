-- Step 1: Add new roles to user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'medical_director';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'nursing_head';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'finance';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'rhb';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'hospital_ceo';