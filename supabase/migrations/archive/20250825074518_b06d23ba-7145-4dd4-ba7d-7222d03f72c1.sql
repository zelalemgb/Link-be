-- Add decision tree response storage to visits table
-- This will be used to store the complete decision tree session data
ALTER TABLE visits ADD COLUMN IF NOT EXISTS decision_tree_responses JSONB;

-- Add comment to describe the new column
COMMENT ON COLUMN visits.decision_tree_responses IS 'Stores clinical decision tree session data including scenario ID, responses, outcomes, and completion status';

-- Create index for querying decision tree data
CREATE INDEX IF NOT EXISTS idx_visits_decision_tree_responses ON visits USING GIN (decision_tree_responses);

-- Example structure of decision_tree_responses JSONB:
-- {
--   "sessions": [
--     {
--       "scenarioId": "hypertension_follow_up",
--       "visitId": "uuid",
--       "patientId": "uuid", 
--       "responses": [
--         {
--           "stepId": "htn_s1",
--           "answer": "150/95",
--           "timestamp": "2024-01-01T10:00:00Z"
--         }
--       ],
--       "finalOutcome": "htn_out_adjust_medication",
--       "isCompleted": true,
--       "startedAt": "2024-01-01T10:00:00Z",
--       "completedAt": "2024-01-01T10:05:00Z"
--     }
--   ]
-- }