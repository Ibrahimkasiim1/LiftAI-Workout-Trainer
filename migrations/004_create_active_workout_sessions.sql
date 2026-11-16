-- ============================================================================
-- CREATE: active_workout_sessions (canonical in-progress workout state)
-- ============================================================================
-- This table is the single source of truth for active workouts.
-- It replaces any reliance on workout_sessions/AsyncStorage.
-- ============================================================================

-- Ensure UUID generator exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS active_workout_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  session_id UUID DEFAULT uuid_generate_v4(),
  workout_id UUID,
  workout_name TEXT NOT NULL,
  workout_type TEXT NOT NULL CHECK (
    workout_type IN (
      'main_plan',
      'extra_workout',
      'saved_workout',
      'replacement_workout',
      'quick_workout'
    )
  ),
  exercises TEXT[] NOT NULL DEFAULT '{}',
  exercises_structured JSONB,
  estimated_time INTEGER NOT NULL,
  difficulty TEXT,
  current_exercise_index INTEGER DEFAULT 0,
  current_set INTEGER DEFAULT 1,
  total_sets INTEGER DEFAULT 3,
  sets_completed JSONB DEFAULT '[]'::jsonb,
  rest_time_remaining INTEGER,
  rest_time_duration INTEGER,
  is_resting BOOLEAN DEFAULT false,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT active_workout_sessions_user_type_unique UNIQUE (user_id, workout_type)
);

-- Enable RLS on active_workout_sessions
ALTER TABLE active_workout_sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for active_workout_sessions
DROP POLICY IF EXISTS "Users can view their own active sessions" ON active_workout_sessions;
CREATE POLICY "Users can view their own active sessions" ON active_workout_sessions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own active sessions" ON active_workout_sessions;
CREATE POLICY "Users can insert their own active sessions" ON active_workout_sessions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own active sessions" ON active_workout_sessions;
CREATE POLICY "Users can update their own active sessions" ON active_workout_sessions
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own active sessions" ON active_workout_sessions;
CREATE POLICY "Users can delete their own active sessions" ON active_workout_sessions
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes for active_workout_sessions
CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_workout_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_active_workout_sessions_user_type
  ON active_workout_sessions(user_id, workout_type);
CREATE INDEX IF NOT EXISTS idx_active_workout_sessions_user_started
  ON active_workout_sessions(user_id, workout_type, started_at DESC);

-- Ensure updated_at trigger exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_active_workout_sessions_updated_at ON active_workout_sessions;
CREATE TRIGGER update_active_workout_sessions_updated_at
  BEFORE UPDATE ON active_workout_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
