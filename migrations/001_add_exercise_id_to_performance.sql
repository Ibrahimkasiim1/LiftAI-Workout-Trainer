-- =====================================================
-- EXERCISE PERFORMANCE ID MIGRATION
-- =====================================================
-- 
-- Migrates exercise_performance table from name-based to ID-based tracking
-- 
-- WHY THIS IS CRITICAL:
-- - Name-based tracking causes orphaned history when exercises are renamed
-- - No referential integrity to exercises table
-- - Inefficient queries (text comparison vs UUID lookup)
-- - Cannot track exercise metadata changes over time
--
-- MIGRATION STRATEGY:
-- 1. Add exercise_id column (nullable initially)
-- 2. Backfill existing data by matching exercise_name to exercises table
-- 3. Mark unmatched entries (exercises that no longer exist)
-- 4. Add constraint to require exercise_id for new entries
-- 5. Create new indexes for ID-based queries
-- 6. Keep exercise_name as fallback for backwards compatibility
-- 
-- SAFETY: This migration is NON-DESTRUCTIVE
-- - exercise_name column is retained
-- - Existing data is preserved
-- - Rollback-able
-- =====================================================

-- Step 1: Add exercise_id column (nullable for existing data)
ALTER TABLE exercise_performance 
ADD COLUMN IF NOT EXISTS exercise_id UUID;

-- Step 2: Add reference comment
COMMENT ON COLUMN exercise_performance.exercise_id IS 
  'Foreign key to exercises table. New entries MUST include exercise_id. Legacy entries may only have exercise_name.';

-- Step 3: Backfill exercise_id for existing records
-- Match by exact name to exercises table
UPDATE exercise_performance ep
SET exercise_id = e.id
FROM exercises e
WHERE ep.exercise_id IS NULL
  AND ep.exercise_name = e.name;

-- Step 4: Create index on exercise_id for performance
CREATE INDEX IF NOT EXISTS idx_exercise_performance_exercise_id 
  ON exercise_performance(exercise_id);

CREATE INDEX IF NOT EXISTS idx_exercise_performance_user_exercise_id 
  ON exercise_performance(user_id, exercise_id);

CREATE INDEX IF NOT EXISTS idx_exercise_performance_user_exercise_id_date 
  ON exercise_performance(user_id, exercise_id, workout_date DESC);

-- Step 5: Add foreign key constraint (with ON DELETE SET NULL to preserve history)
-- This allows exercise history to remain even if an exercise is deleted
ALTER TABLE exercise_performance
ADD CONSTRAINT fk_exercise_performance_exercise
FOREIGN KEY (exercise_id) 
REFERENCES exercises(id) 
ON DELETE SET NULL;

-- Step 6: Add check constraint for new entries
-- New entries (created after this migration) MUST have exercise_id
-- Legacy entries (before migration) are grandfathered in
ALTER TABLE exercise_performance
ADD CONSTRAINT chk_new_entries_require_exercise_id 
CHECK (
  -- If created after migration date, must have exercise_id
  created_at < '2025-12-14'::timestamp OR exercise_id IS NOT NULL
);

-- Step 7: Update RLS policies to work with both name and ID
-- No changes needed - policies are based on user_id

-- Step 8: Create helper view for exercise performance with metadata
CREATE OR REPLACE VIEW exercise_performance_with_metadata AS
SELECT 
  ep.id,
  ep.user_id,
  ep.exercise_id,
  ep.exercise_name,
  -- Join exercise metadata if exercise_id exists
  COALESCE(e.name, ep.exercise_name) as current_exercise_name,
  e.target_muscle,
  e.equipment,
  e.body_part,
  e.gif_path,
  ep.workout_date,
  ep.set_number,
  ep.reps_completed,
  ep.weight_used,
  ep.comment,
  ep.created_at,
  -- Flag for whether this is a legacy entry
  CASE 
    WHEN ep.exercise_id IS NULL THEN true 
    ELSE false 
  END as is_legacy_entry
FROM exercise_performance ep
LEFT JOIN exercises e ON ep.exercise_id = e.id;

COMMENT ON VIEW exercise_performance_with_metadata IS 
  'Exercise performance with joined exercise metadata. Handles both legacy (name-only) and new (ID-based) entries.';

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- 
-- Summary:
-- Added exercise_id column
-- Backfilled existing data where possible
-- Created optimized indexes
-- Added foreign key constraint (nullable for history preservation)
-- New entries require exercise_id
-- Legacy entries preserved with exercise_name
-- Created helper view for queries
-- 
-- Next steps:
-- 1. Update ProgressService to use exercise_id
-- 2. Update WorkoutService to include exercise_id when logging sets
-- 3. Update TikTokScroll to pass exercise_id
-- 4. Test queries with both legacy and new data
-- 
-- Rollback (if needed):
-- ALTER TABLE exercise_performance DROP CONSTRAINT IF EXISTS chk_new_entries_require_exercise_id;
-- ALTER TABLE exercise_performance DROP CONSTRAINT IF EXISTS fk_exercise_performance_exercise;
-- DROP INDEX IF EXISTS idx_exercise_performance_exercise_id;
-- DROP INDEX IF EXISTS idx_exercise_performance_user_exercise_id;
-- DROP INDEX IF EXISTS idx_exercise_performance_user_exercise_id_date;
-- ALTER TABLE exercise_performance DROP COLUMN IF EXISTS exercise_id;
-- DROP VIEW IF EXISTS exercise_performance_with_metadata;
-- 
-- =====================================================
