-- ============================================================================
-- FIX: Update cleanup_old_workout_sessions() for new workout_sessions table
-- ============================================================================
-- The old function referenced 'active_workout_sessions' which was dropped.
-- This migration updates the function to work with the new 'workout_sessions' table.
-- ============================================================================

-- Drop the old function if it exists
DROP FUNCTION IF EXISTS cleanup_old_workout_sessions();

-- Create new function targeting workout_sessions
CREATE OR REPLACE FUNCTION cleanup_old_workout_sessions()
RETURNS void AS $$
BEGIN
  -- Delete stale sessions where:
  -- 1. Not completed (completed_at IS NULL)
  -- 2. Last activity was more than 24 hours ago
  -- Falls back to started_at if last_activity_at is NULL
  DELETE FROM workout_sessions
  WHERE completed_at IS NULL
    AND COALESCE(last_activity_at, started_at) < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION cleanup_old_workout_sessions TO authenticated;
