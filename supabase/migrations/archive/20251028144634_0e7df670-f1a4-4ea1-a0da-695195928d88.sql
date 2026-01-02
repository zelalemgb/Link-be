-- Add logistic_officer role to user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'logistic_officer';