-- Add new columns to feature_requests table for enhanced status tracking
ALTER TABLE public.feature_requests
ADD COLUMN IF NOT EXISTS deprioritize_reason TEXT,
ADD COLUMN IF NOT EXISTS estimated_completion DATE,
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;