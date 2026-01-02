-- Add journey_timeline column to track patient journey stages
ALTER TABLE visits ADD COLUMN IF NOT EXISTS journey_timeline JSONB DEFAULT '{"stages": []}'::jsonb;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_visits_journey_timeline ON visits USING gin(journey_timeline);

-- Add comment to explain the structure
COMMENT ON COLUMN visits.journey_timeline IS 'Tracks patient journey stages with timestamps: {"stages": [{"stage": "registered", "timestamp": "2024-01-01T10:00:00Z", "completedBy": "user-id"}]}';