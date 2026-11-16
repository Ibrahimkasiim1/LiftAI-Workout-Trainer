-- =====================================================
-- COMPLETE SUPABASE DATABASE SETUP FOR LIFTAI APP
-- =====================================================
-- 
-- This is a comprehensive database setup script that includes
-- ALL tables, indexes, RLS policies, triggers, and views needed
-- for the LiftAI fitness app to work with a new Supabase project.
-- 
-- This script is safe to run multiple times (idempotent).
-- Run this in your Supabase SQL Editor.
-- 
-- =====================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For text search if needed

-- =====================================================
-- 1. USER PROFILES TABLE
-- =====================================================
-- Core user profile data collected during onboarding
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  birthday DATE NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('Male', 'Female', 'Other')),
  height_cm DECIMAL(5,2) NOT NULL CHECK (height_cm > 0),
  height_unit TEXT DEFAULT 'cm' CHECK (height_unit IN ('cm', 'ft')),
  weight_kg DECIMAL(5,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 1000),
  weight_unit TEXT NOT NULL DEFAULT 'kg' CHECK (weight_unit IN ('kg', 'lbs')),
  goal TEXT NOT NULL CHECK (goal IN ('gain', 'build_muscle', 'maintain', 'lose')),
  goal_weight_kg DECIMAL(5,2) NOT NULL CHECK (goal_weight_kg > 0 AND goal_weight_kg <= 1000),
  pace TEXT NOT NULL CHECK (pace IN ('slow', 'medium', 'fast')),
  fitness_level TEXT NOT NULL CHECK (fitness_level IN ('beginner', 'intermediate', 'expert')),
  workout_days_per_week INTEGER NOT NULL CHECK (workout_days_per_week >= 1 AND workout_days_per_week <= 7),
  workout_split_type TEXT NOT NULL CHECK (workout_split_type IN ('full_body', 'upper_lower', 'ppl', 'bro_split', 'hybrid', 'custom')),
  custom_split JSONB,
  workout_duration_minutes INTEGER NOT NULL CHECK (workout_duration_minutes > 0),
  location TEXT NOT NULL CHECK (location IN ('home', 'gym')),
  available_equipment TEXT[] NOT NULL DEFAULT '{}',
  injuries TEXT,
  onboarding_completed BOOLEAN DEFAULT false,
  onboarding_questions_completed BOOLEAN DEFAULT false,
  notifications_enabled BOOLEAN DEFAULT false,
  notification_permission_requested BOOLEAN DEFAULT false,
  selected_workout_days JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on user_profiles
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies for user_profiles
DROP POLICY IF EXISTS "Users can view their own profile" ON user_profiles;
CREATE POLICY "Users can view their own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert their own profile" ON user_profiles;
CREATE POLICY "Users can insert their own profile" ON user_profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update their own profile" ON user_profiles;
CREATE POLICY "Users can update their own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);

-- Indexes for user_profiles
CREATE INDEX IF NOT EXISTS idx_user_profiles_onboarding_completed ON user_profiles(onboarding_completed);
CREATE INDEX IF NOT EXISTS idx_user_profiles_selected_workout_days ON user_profiles USING GIN (selected_workout_days);
CREATE INDEX IF NOT EXISTS idx_user_profiles_weight_unit ON user_profiles(weight_unit);
CREATE INDEX IF NOT EXISTS idx_user_profiles_height_unit ON user_profiles(height_unit);

-- =====================================================
-- 2. WORKOUT PLANS TABLE
-- =====================================================
-- Stores AI-generated workout plans for users
CREATE TABLE IF NOT EXISTS workout_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE NOT NULL,
  plan_name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

-- Enable RLS on workout_plans
ALTER TABLE workout_plans ENABLE ROW LEVEL SECURITY;

-- RLS Policies for workout_plans
DROP POLICY IF EXISTS "Users can view their own workout plans" ON workout_plans;
CREATE POLICY "Users can view their own workout plans" ON workout_plans
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own workout plans" ON workout_plans;
CREATE POLICY "Users can insert their own workout plans" ON workout_plans
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own workout plans" ON workout_plans;
CREATE POLICY "Users can update their own workout plans" ON workout_plans
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own workout plans" ON workout_plans;
CREATE POLICY "Users can delete their own workout plans" ON workout_plans
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes for workout_plans
CREATE INDEX IF NOT EXISTS idx_workout_plans_user_active ON workout_plans(user_id, is_active) WHERE is_active = true;

-- =====================================================
-- 3. DAILY WORKOUTS TABLE
-- =====================================================
-- Stores exercises for each day in a workout plan
CREATE TABLE IF NOT EXISTS daily_workouts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id UUID REFERENCES workout_plans(id) ON DELETE CASCADE NOT NULL,
  day_of_week TEXT NOT NULL CHECK (day_of_week IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  split_day_name TEXT NOT NULL,
  exercises TEXT[] NOT NULL DEFAULT '{}',
  exercises_structured JSONB,
  estimated_time INTEGER NOT NULL CHECK (estimated_time > 0 AND estimated_time <= 300),
  notes TEXT
);

-- Enable RLS on daily_workouts
ALTER TABLE daily_workouts ENABLE ROW LEVEL SECURITY;

-- RLS Policies for daily_workouts
DROP POLICY IF EXISTS "Users can view their own daily workouts" ON daily_workouts;
CREATE POLICY "Users can view their own daily workouts" ON daily_workouts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM workout_plans 
      WHERE workout_plans.id = daily_workouts.plan_id 
      AND workout_plans.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert their own daily workouts" ON daily_workouts;
CREATE POLICY "Users can insert their own daily workouts" ON daily_workouts
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM workout_plans 
      WHERE workout_plans.id = daily_workouts.plan_id 
      AND workout_plans.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update their own daily workouts" ON daily_workouts;
CREATE POLICY "Users can update their own daily workouts" ON daily_workouts
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM workout_plans 
      WHERE workout_plans.id = daily_workouts.plan_id 
      AND workout_plans.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete their own daily workouts" ON daily_workouts;
CREATE POLICY "Users can delete their own daily workouts" ON daily_workouts
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM workout_plans 
      WHERE workout_plans.id = daily_workouts.plan_id 
      AND workout_plans.user_id = auth.uid()
    )
  );

-- Indexes for daily_workouts
CREATE INDEX IF NOT EXISTS idx_daily_workouts_plan_day ON daily_workouts(plan_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_daily_workouts_exercises_structured ON daily_workouts USING GIN (exercises_structured);

-- =====================================================
-- 4. EXERCISE PERFORMANCE TABLE
-- =====================================================
-- Tracks user's exercise performance data for progress tracking
CREATE TABLE IF NOT EXISTS exercise_performance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  exercise_name TEXT NOT NULL,
  workout_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  set_number INTEGER NOT NULL,
  reps_completed INTEGER NOT NULL,
  weight_used DECIMAL(6,2),
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on exercise_performance
ALTER TABLE exercise_performance ENABLE ROW LEVEL SECURITY;

-- RLS Policies for exercise_performance
DROP POLICY IF EXISTS "Users can view their own performance" ON exercise_performance;
CREATE POLICY "Users can view their own performance" ON exercise_performance
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own performance" ON exercise_performance;
CREATE POLICY "Users can insert their own performance" ON exercise_performance
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own performance" ON exercise_performance;
CREATE POLICY "Users can update their own performance" ON exercise_performance
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own performance" ON exercise_performance;
CREATE POLICY "Users can delete their own performance" ON exercise_performance
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes for exercise_performance
CREATE INDEX IF NOT EXISTS idx_exercise_performance_user ON exercise_performance(user_id);
CREATE INDEX IF NOT EXISTS idx_exercise_performance_exercise ON exercise_performance(user_id, exercise_name);
CREATE INDEX IF NOT EXISTS idx_exercise_performance_date ON exercise_performance(workout_date);
CREATE INDEX IF NOT EXISTS idx_exercise_performance_comment ON exercise_performance(user_id, exercise_name) WHERE comment IS NOT NULL;

-- =====================================================
-- 5. WORKOUT COMPLETIONS TABLE
-- =====================================================
-- Tracks workout completions for consistency/streak tracking
CREATE TABLE IF NOT EXISTS workout_completions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  completion_date DATE NOT NULL,
  workout_type TEXT CHECK (workout_type IN ('workout', 'rest')) NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, completion_date)
);

-- Enable RLS on workout_completions
ALTER TABLE workout_completions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for workout_completions
DROP POLICY IF EXISTS "Users can view their own completions" ON workout_completions;
CREATE POLICY "Users can view their own completions" ON workout_completions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own completions" ON workout_completions;
CREATE POLICY "Users can insert their own completions" ON workout_completions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own completions" ON workout_completions;
CREATE POLICY "Users can update their own completions" ON workout_completions
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own completions" ON workout_completions;
CREATE POLICY "Users can delete their own completions" ON workout_completions
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes for workout_completions
CREATE INDEX IF NOT EXISTS idx_workout_completions_user ON workout_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_workout_completions_date ON workout_completions(completion_date);
CREATE INDEX IF NOT EXISTS idx_workout_completions_user_date ON workout_completions(user_id, completion_date DESC);

-- =====================================================
-- 6. CHAT MESSAGES TABLE
-- =====================================================
-- Stores persistent chat conversation history
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on chat_messages
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- RLS Policies for chat_messages
DROP POLICY IF EXISTS "Users can view own messages" ON chat_messages;
CREATE POLICY "Users can view own messages"
  ON chat_messages FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own messages" ON chat_messages;
CREATE POLICY "Users can insert own messages"
  ON chat_messages FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own messages" ON chat_messages;
CREATE POLICY "Users can delete own messages"
  ON chat_messages FOR DELETE
  USING (auth.uid() = user_id);

-- Indexes for chat_messages
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_conversation 
  ON chat_messages(user_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON chat_messages(conversation_id, created_at ASC);

-- =====================================================
-- 7. SAVED WORKOUTS TABLE
-- =====================================================
-- Stores all user-generated and saved workouts
CREATE TABLE IF NOT EXISTS saved_workouts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  workout_name TEXT NOT NULL,
  workout_type TEXT NOT NULL CHECK (workout_type IN ('main_plan', 'main_plan_edit', 'extra_workout', 'replacement_workout')),
  exercises TEXT[] NOT NULL DEFAULT '{}',
  exercises_structured JSONB,
  estimated_time INTEGER NOT NULL CHECK (estimated_time > 0 AND estimated_time <= 300),
  difficulty TEXT,
  description TEXT,
  replacement_for TEXT,
  replacement_date DATE,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on saved_workouts
ALTER TABLE saved_workouts ENABLE ROW LEVEL SECURITY;

-- RLS Policies for saved_workouts
DROP POLICY IF EXISTS "Users can view their own saved workouts" ON saved_workouts;
CREATE POLICY "Users can view their own saved workouts" ON saved_workouts
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own saved workouts" ON saved_workouts;
CREATE POLICY "Users can insert their own saved workouts" ON saved_workouts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own saved workouts" ON saved_workouts;
CREATE POLICY "Users can update their own saved workouts" ON saved_workouts
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own saved workouts" ON saved_workouts;
CREATE POLICY "Users can delete their own saved workouts" ON saved_workouts
  FOR DELETE USING (auth.uid() = user_id);

-- Indexes for saved_workouts
CREATE INDEX IF NOT EXISTS idx_saved_workouts_user ON saved_workouts(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_workouts_user_created ON saved_workouts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_workouts_type ON saved_workouts(user_id, workout_type);

-- =====================================================
-- 8. ACTIVE WORKOUT SESSIONS TABLE
-- =====================================================
-- Stores currently active workout sessions for "Continue" functionality
CREATE TABLE IF NOT EXISTS active_workout_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  session_id UUID DEFAULT uuid_generate_v4(),
  workout_id UUID,
  workout_name TEXT NOT NULL,
  workout_type TEXT NOT NULL CHECK (workout_type IN ('main_plan', 'extra_workout', 'saved_workout', 'replacement_workout')),
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

-- =====================================================
-- 9. TRIGGERS FOR UPDATED_AT TIMESTAMPS
-- =====================================================
-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for tables with updated_at columns
DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON user_profiles;
CREATE TRIGGER update_user_profiles_updated_at 
  BEFORE UPDATE ON user_profiles 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_saved_workouts_updated_at ON saved_workouts;
CREATE TRIGGER update_saved_workouts_updated_at 
  BEFORE UPDATE ON saved_workouts 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_active_workout_sessions_updated_at ON active_workout_sessions;
CREATE TRIGGER update_active_workout_sessions_updated_at 
  BEFORE UPDATE ON active_workout_sessions 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 10. HELPFUL VIEWS
-- =====================================================

-- View: User's active workout plan with daily schedule
CREATE OR REPLACE VIEW user_active_workout_plan AS
SELECT 
  wp.id as plan_id,
  wp.user_id,
  wp.plan_name,
  wp.created_at as plan_created_at,
  dw.day_of_week,
  dw.split_day_name,
  dw.exercises,
  dw.exercises_structured,
  dw.estimated_time,
  dw.notes
FROM workout_plans wp
LEFT JOIN daily_workouts dw ON wp.id = dw.plan_id
WHERE wp.is_active = true
ORDER BY 
  CASE dw.day_of_week
    WHEN 'monday' THEN 1
    WHEN 'tuesday' THEN 2
    WHEN 'wednesday' THEN 3
    WHEN 'thursday' THEN 4
    WHEN 'friday' THEN 5
    WHEN 'saturday' THEN 6
    WHEN 'sunday' THEN 7
  END;

-- View: Main workout plan grouped by user
CREATE OR REPLACE VIEW user_main_workout_plan AS
SELECT 
  wp.id as plan_id,
  wp.user_id,
  wp.plan_name,
  wp.created_at,
  json_agg(
    json_build_object(
      'day_of_week', dw.day_of_week,
      'split_day_name', dw.split_day_name,
      'exercises', dw.exercises,
      'exercises_structured', dw.exercises_structured,
      'estimated_time', dw.estimated_time
    ) ORDER BY CASE dw.day_of_week
      WHEN 'monday' THEN 1
      WHEN 'tuesday' THEN 2
      WHEN 'wednesday' THEN 3
      WHEN 'thursday' THEN 4
      WHEN 'friday' THEN 5
      WHEN 'saturday' THEN 6
      WHEN 'sunday' THEN 7
    END
  ) as weekly_schedule
FROM workout_plans wp
LEFT JOIN daily_workouts dw ON wp.id = dw.plan_id
WHERE wp.is_active = true
GROUP BY wp.id, wp.user_id, wp.plan_name, wp.created_at;

-- View: All user workouts (saved + main plan)
CREATE OR REPLACE VIEW user_all_workouts AS
SELECT 
  sw.id,
  sw.user_id,
  sw.workout_name,
  sw.workout_type,
  sw.exercises,
  sw.exercises_structured,
  sw.estimated_time,
  sw.difficulty,
  sw.description,
  sw.created_at,
  'saved' as source
FROM saved_workouts sw
UNION ALL
SELECT 
  dw.id,
  wp.user_id,
  dw.split_day_name as workout_name,
  'main_plan' as workout_type,
  dw.exercises,
  dw.exercises_structured,
  dw.estimated_time,
  NULL as difficulty,
  dw.notes as description,
  wp.created_at,
  'main_plan' as source
FROM daily_workouts dw
JOIN workout_plans wp ON dw.plan_id = wp.id
WHERE wp.is_active = true
ORDER BY created_at DESC;

-- View: Conversation summaries from chat messages
DROP TABLE IF EXISTS conversation_summaries CASCADE;
DROP VIEW IF EXISTS conversation_summaries CASCADE;

CREATE VIEW conversation_summaries AS
SELECT 
  user_id,
  conversation_id,
  MIN(created_at) as started_at,
  MAX(created_at) as last_message_at,
  COUNT(*) as message_count,
  (SELECT content FROM chat_messages cm2 
   WHERE cm2.conversation_id = chat_messages.conversation_id 
     AND cm2.role = 'user' 
   ORDER BY created_at ASC 
   LIMIT 1) as first_user_message
FROM chat_messages
GROUP BY user_id, conversation_id;

-- =====================================================
-- 11. UTILITY FUNCTIONS
-- =====================================================

-- Function to cleanup old workout sessions (older than 24 hours)
-- Updated to use new workout_sessions table schema
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

COMMENT ON FUNCTION cleanup_old_workout_sessions IS 
'Cleans up stale workout sessions that have not been completed and have been inactive for more than 24 hours. 
Updated: 2024-12-13 - Fixed to use workout_sessions table instead of deprecated active_workout_sessions.';

-- Function to delete the authenticated user's account
-- This is called from the app via RPC when user confirms account deletion
-- SECURITY DEFINER allows this function to delete from auth.users table
CREATE OR REPLACE FUNCTION delete_user()
RETURNS void AS $$
BEGIN
  -- Delete from auth.users table
  -- This will CASCADE to user_profiles and all related tables due to foreign key constraints
  DELETE FROM auth.users WHERE id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- 12. COMMENTS ON TABLES AND COLUMNS
-- =====================================================

COMMENT ON TABLE user_profiles IS 'User profile information collected during onboarding';
COMMENT ON TABLE workout_plans IS 'AI-generated workout plans for users';
COMMENT ON TABLE daily_workouts IS 'Individual day workouts within a workout plan';
COMMENT ON TABLE exercise_performance IS 'Exercise performance tracking data (sets, reps, weight)';
COMMENT ON TABLE workout_completions IS 'Workout completion history for streak/consistency tracking';
COMMENT ON TABLE chat_messages IS 'Persistent chat conversation history';
COMMENT ON TABLE saved_workouts IS 'User-generated and saved workouts';
COMMENT ON TABLE active_workout_sessions IS 'Currently active workout sessions for continuation';

COMMENT ON COLUMN user_profiles.selected_workout_days IS 'JSONB object mapping day names to workout time strings';
COMMENT ON COLUMN user_profiles.custom_split IS 'Custom workout split configuration for advanced users';
COMMENT ON COLUMN daily_workouts.exercises_structured IS 'Structured exercise data with sets, reps, rest periods';
COMMENT ON COLUMN active_workout_sessions.current_exercise_index IS 'Index of the current exercise (0-based)';
COMMENT ON COLUMN active_workout_sessions.current_set IS 'Current set number being performed (1-based)';
COMMENT ON COLUMN active_workout_sessions.total_sets IS 'Total number of sets for the current exercise';
COMMENT ON COLUMN active_workout_sessions.sets_completed IS 'Array of completed set performance logs';
COMMENT ON COLUMN active_workout_sessions.rest_time_remaining IS 'Remaining seconds in rest timer';
COMMENT ON COLUMN active_workout_sessions.rest_time_duration IS 'Total duration of rest timer in seconds';
COMMENT ON COLUMN active_workout_sessions.is_resting IS 'Whether the user is currently in a rest period';
COMMENT ON COLUMN active_workout_sessions.workout_type IS 'Type: main_plan, extra_workout, saved_workout, or replacement_workout';

-- =====================================================
-- 13. VERIFICATION QUERIES
-- =====================================================

-- Verify all tables were created
SELECT 
  'Tables Created:' as status,
  COUNT(*) as count
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN (
  'user_profiles', 
  'workout_plans', 
  'daily_workouts',
  'exercise_performance',
  'workout_completions',
  'chat_messages',
  'saved_workouts',
  'active_workout_sessions'
);

-- Verify RLS is enabled on all tables
SELECT 
  'RLS Enabled:' as status,
  COUNT(*) as count
FROM pg_tables 
WHERE schemaname = 'public'
AND tablename IN (
  'user_profiles', 
  'workout_plans', 
  'daily_workouts',
  'exercise_performance',
  'workout_completions',
  'chat_messages',
  'saved_workouts',
  'active_workout_sessions'
)
AND rowsecurity = true;

-- View all RLS policies
SELECT 
  schemaname, 
  tablename, 
  policyname,
  permissive,
  roles,
  cmd
FROM pg_policies 
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- View all indexes
SELECT 
  schemaname,
  tablename,
  indexname
FROM pg_indexes
WHERE schemaname = 'public'
AND tablename IN (
  'user_profiles', 
  'workout_plans', 
  'daily_workouts',
  'exercise_performance',
  'workout_completions',
  'chat_messages',
  'saved_workouts',
  'active_workout_sessions'
)
ORDER BY tablename, indexname;

-- View all views
SELECT 
  table_name
FROM information_schema.views
WHERE table_schema = 'public'
AND table_name IN (
  'user_active_workout_plan',
  'user_main_workout_plan',
  'user_all_workouts',
  'conversation_summaries'
);

-- =====================================================
-- DATABASE SETUP COMPLETE!
-- =====================================================
-- 
-- Your Supabase database is now fully configured for the LiftAI app!
-- 
-- Summary:
-- 8 core tables with proper constraints
-- Row Level Security (RLS) enabled on all tables
-- Comprehensive RLS policies for data isolation
-- Optimized indexes for query performance
-- Automated triggers for timestamp management
-- 4 helpful views for common queries
-- Utility functions for maintenance
-- 
-- Next steps:
-- 1. Update your .env file with new Supabase credentials
-- 2. Test authentication flow
-- 3. Run onboarding process
-- 4. Verify all app features work correctly
-- 
-- =====================================================
