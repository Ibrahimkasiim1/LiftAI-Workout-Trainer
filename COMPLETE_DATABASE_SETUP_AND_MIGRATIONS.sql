-- =====================================================
-- COMPLETE DATABASE SETUP AND ALL MIGRATIONS
-- LiftAI Application - Comprehensive SQL Compilation
-- =====================================================
-- 
-- This file contains ALL SQL code that has been run on the database:
-- 1. Initial unified database setup
-- 2. All migrations in chronological order
-- 3. All table definitions and schemas
-- 
-- IMPORTANT NOTES:
-- - This is a compilation of all SQL executed on the database
-- - Some migrations may have altered tables created in previous steps
-- - The final state of the database reflects all these changes
-- - Tables referenced: user_profiles, workout_plans, daily_workouts, 
--   exercise_performance, workout_completions, chat_messages, 
--   saved_workouts, active_workout_sessions, exercises, plan_overrides,
--   user_contexts, exercise_history, pending_plan_edits, 
--   conversation_state, workouts, plan_days, workout_sessions
-- 
-- =====================================================

-- =====================================================
-- SECTION 1: UNIFIED DATABASE SETUP (INITIAL)
-- =====================================================
-- This is the base setup that creates the core tables
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
CREATE OR REPLACE FUNCTION cleanup_old_workout_sessions()
RETURNS void AS $$
BEGIN
  DELETE FROM active_workout_sessions
  WHERE started_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
-- SECTION 2: MIGRATIONS
-- =====================================================
-- All migrations applied in chronological order
-- =====================================================


-- =====================================================
-- MIGRATION 001: Add exercise_id to performance
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

-- Step 7: Create helper view for exercise performance with metadata
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
-- MIGRATION 002: Fix cleanup function
-- =====================================================

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


-- =====================================================
-- MIGRATION 003: Pending plan edits
-- =====================================================

-- Ensure gen_random_uuid() exists
create extension if not exists pgcrypto;

create table if not exists pending_plan_edits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Enforce 1 pending edit per (user, conversation) so we can UPSERT cleanly
create unique index if not exists uq_pending_edits_user_conversation
  on pending_plan_edits(user_id, conversation_id);

-- Useful for "fallback to most recent"
create index if not exists idx_pending_edits_user_created
  on pending_plan_edits(user_id, created_at desc);

-- RLS (critical)
alter table pending_plan_edits enable row level security;

create policy "pending edits: owner read"
on pending_plan_edits for select
using (auth.uid() = user_id);

create policy "pending edits: owner write"
on pending_plan_edits for insert
with check (auth.uid() = user_id);

create policy "pending edits: owner update"
on pending_plan_edits for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "pending edits: owner delete"
on pending_plan_edits for delete
using (auth.uid() = user_id);


-- =====================================================
-- MIGRATION 004: Create active workout sessions (RECREATE)
-- =====================================================

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
DROP TRIGGER IF EXISTS update_active_workout_sessions_updated_at ON active_workout_sessions;
CREATE TRIGGER update_active_workout_sessions_updated_at
  BEFORE UPDATE ON active_workout_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =====================================================
-- MIGRATION 005: Update saved_workouts workout_type
-- =====================================================

ALTER TABLE saved_workouts
  DROP CONSTRAINT IF EXISTS saved_workouts_workout_type_check;

ALTER TABLE saved_workouts
  ADD CONSTRAINT saved_workouts_workout_type_check
  CHECK (
    workout_type IN (
      'main_plan',
      'main_plan_edit',
      'extra_workout',
      'replacement_workout',
      'quick_workout'
    )
  );


-- =====================================================
-- MIGRATION 006: Create conversation state
-- =====================================================

-- Ensure gen_random_uuid() exists
create extension if not exists pgcrypto;

create table if not exists conversation_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text not null,
  agent text,
  scope text,
  pending_edit_id uuid,
  last_clarification text,
  updated_at timestamptz not null default now()
);

-- Enforce 1 state row per (user, conversation)
create unique index if not exists uq_conversation_state_user_conversation
  on conversation_state(user_id, conversation_id);

-- Useful for "most recent by user"
create index if not exists idx_conversation_state_user_updated
  on conversation_state(user_id, updated_at desc);

-- RLS (critical)
alter table conversation_state enable row level security;

create policy "conversation state: owner read"
on conversation_state for select
using (auth.uid() = user_id);

create policy "conversation state: owner write"
on conversation_state for insert
with check (auth.uid() = user_id);

create policy "conversation state: owner update"
on conversation_state for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "conversation state: owner delete"
on conversation_state for delete
using (auth.uid() = user_id);


-- =====================================================
-- MIGRATION 007: Add temporal context tables
-- =====================================================

-- ============================================================================
-- 1. PLAN OVERRIDES TABLE
-- ============================================================================
-- Stores temporary plan modifications (injuries, vacation, equipment changes)
-- These auto-expire after the specified end_date

CREATE TABLE IF NOT EXISTS plan_overrides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
    override_type TEXT NOT NULL CHECK (override_type IN (
        'equipment_change',
        'injury_accommodation', 
        'vacation',
        'intensity_reduction'
    )),
    reason TEXT NOT NULL,
    start_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_date TIMESTAMPTZ NOT NULL,
    modifications JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure end_date is after start_date
    CONSTRAINT valid_date_range CHECK (end_date > start_date)
);

-- Enable RLS on plan_overrides
ALTER TABLE plan_overrides ENABLE ROW LEVEL SECURITY;

-- RLS Policies for plan_overrides
DROP POLICY IF EXISTS "Users can view their own overrides" ON plan_overrides;
CREATE POLICY "Users can view their own overrides" ON plan_overrides
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own overrides" ON plan_overrides;
CREATE POLICY "Users can insert their own overrides" ON plan_overrides
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own overrides" ON plan_overrides;
CREATE POLICY "Users can update their own overrides" ON plan_overrides
    FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own overrides" ON plan_overrides;
CREATE POLICY "Users can delete their own overrides" ON plan_overrides
    FOR DELETE USING (auth.uid() = user_id);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_plan_overrides_user_active 
    ON plan_overrides(user_id, is_active, end_date) 
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_plan_overrides_plan 
    ON plan_overrides(plan_id);

CREATE INDEX IF NOT EXISTS idx_plan_overrides_expiry 
    ON plan_overrides(end_date) 
    WHERE is_active = true;

-- Comments
COMMENT ON TABLE plan_overrides IS 'Temporary workout plan modifications (injuries, vacations) with auto-expiry';
COMMENT ON COLUMN plan_overrides.modifications IS 'JSONB: {equipmentOverride: string[], avoidBodyParts: string[], intensityMultiplier: number, location: string}';

-- ============================================================================
-- 2. USER CONTEXTS TABLE
-- ============================================================================
-- Stores temporary user states (vacation, injuries, equipment changes)
-- Used to merge effective equipment/constraints with base profile

CREATE TABLE IF NOT EXISTS user_contexts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    context_type TEXT NOT NULL CHECK (context_type IN (
        'vacation',
        'injury',
        'equipment_change',
        'location_change'
    )),
    context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Only one active context per type per user
    UNIQUE(user_id, context_type)
);

-- Enable RLS on user_contexts
ALTER TABLE user_contexts ENABLE ROW LEVEL SECURITY;

-- RLS Policies for user_contexts
DROP POLICY IF EXISTS "Users can view their own contexts" ON user_contexts;
CREATE POLICY "Users can view their own contexts" ON user_contexts
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own contexts" ON user_contexts;
CREATE POLICY "Users can insert their own contexts" ON user_contexts
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own contexts" ON user_contexts;
CREATE POLICY "Users can update their own contexts" ON user_contexts
    FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own contexts" ON user_contexts;
CREATE POLICY "Users can delete their own contexts" ON user_contexts
    FOR DELETE USING (auth.uid() = user_id);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_user_contexts_user_active 
    ON user_contexts(user_id, context_type) 
    WHERE expires_at IS NULL OR expires_at > NOW();

CREATE INDEX IF NOT EXISTS idx_user_contexts_expiry 
    ON user_contexts(expires_at) 
    WHERE expires_at IS NOT NULL;

-- Comments
COMMENT ON TABLE user_contexts IS 'Temporary user states (vacation equipment, injuries) that merge with base profile';
COMMENT ON COLUMN user_contexts.context_data IS 'JSONB: {equipment: string[], location: string, avoidBodyParts: string[]}';
COMMENT ON COLUMN user_contexts.expires_at IS 'NULL means permanent, otherwise auto-expires after this timestamp';

-- ============================================================================
-- 3. EXERCISE HISTORY TABLE
-- ============================================================================
-- Tracks exercise performance over time for progressive overload suggestions

CREATE TABLE IF NOT EXISTS exercise_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    workout_id UUID,
    exercise_id UUID NOT NULL,
    exercise_name TEXT NOT NULL,
    sets_completed INTEGER NOT NULL CHECK (sets_completed > 0),
    reps_completed INTEGER NOT NULL CHECK (reps_completed > 0),
    weight_used DECIMAL(6,2) CHECK (weight_used >= 0),
    improved BOOLEAN DEFAULT false,
    notes TEXT,
    completed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on exercise_history
ALTER TABLE exercise_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies for exercise_history
DROP POLICY IF EXISTS "Users can view their own history" ON exercise_history;
CREATE POLICY "Users can view their own history" ON exercise_history
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own history" ON exercise_history;
CREATE POLICY "Users can insert their own history" ON exercise_history
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own history" ON exercise_history;
CREATE POLICY "Users can update their own history" ON exercise_history
    FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own history" ON exercise_history;
CREATE POLICY "Users can delete their own history" ON exercise_history
    FOR DELETE USING (auth.uid() = user_id);

-- Indexes for performance tracking queries
CREATE INDEX IF NOT EXISTS idx_exercise_history_user_exercise 
    ON exercise_history(user_id, exercise_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_exercise_history_user_recent 
    ON exercise_history(user_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_exercise_history_improved 
    ON exercise_history(user_id, improved) 
    WHERE improved = true;

-- Comments
COMMENT ON TABLE exercise_history IS 'Exercise performance history for progressive overload tracking';
COMMENT ON COLUMN exercise_history.improved IS 'True if this performance was better than previous (more weight, reps, or sets)';

-- ============================================================================
-- 4. AUTO-CLEANUP FUNCTION FOR EXPIRED CONTEXTS
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_expired_contexts()
RETURNS void AS $$
BEGIN
    -- Delete expired user contexts
    DELETE FROM user_contexts 
    WHERE expires_at IS NOT NULL 
      AND expires_at < NOW();
    
    -- Deactivate expired plan overrides
    UPDATE plan_overrides 
    SET is_active = false 
    WHERE is_active = true 
      AND end_date < NOW();
      
    RAISE NOTICE 'Cleaned up expired contexts and overrides';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION cleanup_expired_contexts IS 'Removes expired contexts and deactivates expired overrides (run via cron)';


-- =====================================================
-- MIGRATION: Add height_unit column
-- =====================================================

DO $$ 
BEGIN
    -- Add height_unit column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'user_profiles' 
        AND column_name = 'height_unit'
    ) THEN
        ALTER TABLE user_profiles 
        ADD COLUMN height_unit TEXT DEFAULT 'cm' CHECK (height_unit IN ('cm', 'ft'));
        
        -- Add index for height_unit
        CREATE INDEX IF NOT EXISTS idx_user_profiles_height_unit ON user_profiles(height_unit);
        
        RAISE NOTICE 'Successfully added height_unit column to user_profiles';
    ELSE
        RAISE NOTICE 'height_unit column already exists, skipping';
    END IF;
END $$;


-- =====================================================
-- MIGRATION: Fix search_exercises RPC function
-- =====================================================

-- Drop ALL existing overloads of search_exercises
-- Using explicit signatures to handle multiple overloads
DO $$
DECLARE
    func_record RECORD;
BEGIN
    -- Find and drop all functions named search_exercises
    FOR func_record IN 
        SELECT p.oid::regprocedure AS func_signature
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'search_exercises'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || func_record.func_signature || ' CASCADE';
        RAISE NOTICE 'Dropped function: %', func_record.func_signature;
    END LOOP;
END $$;

-- Recreate the search_exercises function with gif_path included
CREATE OR REPLACE FUNCTION search_exercises(
    query_embedding vector(1536),
    match_count integer DEFAULT 10,
    match_threshold float DEFAULT 0.5,
    filter_equipment text[] DEFAULT NULL
)
RETURNS TABLE (
    id text,
    name text,
    target_muscle text,
    body_part text,
    equipment text,
    difficulty text,
    gif_path text,           -- ← ADDED: Required for UI rendering
    instructions text[],
    similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id::text,
        e.name,
        e.target_muscle,
        e.body_part,
        e.equipment,
        e.difficulty,
        e.gif_path,          -- ← ADDED: Now returning gif_path
        e.instructions,
        1 - (e.embedding <=> query_embedding) as similarity
    FROM exercises e
    WHERE 
        -- Only return exercises with valid gif_path (UI-safe filtering)
        e.gif_path IS NOT NULL 
        AND e.gif_path != ''
        -- Apply similarity threshold
        AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
        -- Apply equipment filter if provided
        AND (filter_equipment IS NULL OR e.equipment = ANY(filter_equipment))
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION search_exercises(vector(1536), integer, float, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION search_exercises(vector(1536), integer, float, text[]) TO anon;

-- Add comment documenting the fix
COMMENT ON FUNCTION search_exercises(vector(1536), integer, float, text[]) IS 
'Vector similarity search for exercises. 
Returns exercises with required UI fields including gif_path.
Only returns exercises where gif_path IS NOT NULL (UI-safe pool).
Fixed: 2024-12-13 - Added gif_path to return columns.';


-- =====================================================
-- MIGRATION: Refactor workout architecture
-- =====================================================

-- Step 1: Create workout_kind ENUM
-- ============================================================================
CREATE TYPE workout_kind AS ENUM ('plan', 'override', 'additional');
CREATE TYPE workout_created_by AS ENUM ('onboarding', 'chat', 'adjuster', 'user_edit');

-- Step 2: Ensure workout_plans table exists (needed for plan_days FK)
-- ============================================================================
-- This table should already exist, but we'll create it if needed
CREATE TABLE IF NOT EXISTS workout_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    split_type TEXT,
    goal TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Step 3: Create plan_days table FIRST (workouts will reference this)
-- ============================================================================
-- Represents the structure of the user's training plan
CREATE TABLE IF NOT EXISTS plan_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
    
    weekday TEXT NOT NULL CHECK (weekday IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
    label TEXT NOT NULL, -- "Push Day", "Leg Day", "Rest", etc.
    display_order INTEGER NOT NULL DEFAULT 0,
    
    -- Reference to the base workout definition (will be set after workouts table is created)
    base_workout_id UUID,
    is_rest_day BOOLEAN NOT NULL DEFAULT FALSE,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Ensure only one plan_day per weekday per plan
    UNIQUE(plan_id, weekday)
);

-- Step 4: Create canonical workouts table
-- ============================================================================
-- This is the SINGLE source of truth for all workout definitions
CREATE TABLE IF NOT EXISTS workouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- Workout classification (IMMUTABLE after creation)
    workout_kind workout_kind NOT NULL,
    created_by workout_created_by NOT NULL DEFAULT 'user_edit',
    
    -- Content
    title TEXT NOT NULL,
    description TEXT,
    estimated_minutes INTEGER NOT NULL DEFAULT 30,
    exercises_structured JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Relationship fields (NULLABLE - meaning depends on workout_kind)
    replaces_plan_day_id UUID REFERENCES plan_days(id) ON DELETE SET NULL,
    scheduled_date DATE,
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ
);

-- Now add the FK from plan_days to workouts
ALTER TABLE plan_days 
    ADD CONSTRAINT plan_days_base_workout_fk 
    FOREIGN KEY (base_workout_id) REFERENCES workouts(id) ON DELETE SET NULL;

-- Create indexes for workouts table
CREATE INDEX IF NOT EXISTS idx_workouts_user_scheduled ON workouts (user_id, scheduled_date) 
WHERE scheduled_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workouts_user_kind ON workouts (user_id, workout_kind);

CREATE INDEX IF NOT EXISTS idx_workouts_plan_day ON workouts (replaces_plan_day_id) 
WHERE replaces_plan_day_id IS NOT NULL;

-- Step 5: Add strict CHECK constraints (BUSINESS RULE ENFORCEMENT)
-- ============================================================================

-- RULE: 'override' workouts MUST have both scheduled_date AND replaces_plan_day_id
ALTER TABLE workouts ADD CONSTRAINT check_override_has_date_and_plan
CHECK (
    workout_kind != 'override' OR 
    (scheduled_date IS NOT NULL AND replaces_plan_day_id IS NOT NULL)
);

-- RULE: 'additional' workouts MUST NOT have replaces_plan_day_id
ALTER TABLE workouts ADD CONSTRAINT check_additional_no_plan_reference
CHECK (
    workout_kind != 'additional' OR 
    replaces_plan_day_id IS NULL
);

-- RULE: 'plan' workouts MUST NOT have scheduled_date (they're defined by weekday)
ALTER TABLE workouts ADD CONSTRAINT check_plan_no_scheduled_date
CHECK (
    workout_kind != 'plan' OR 
    scheduled_date IS NULL
);

-- RULE: Only ONE active override per user per date
CREATE UNIQUE INDEX idx_unique_override_per_user_date 
ON workouts (user_id, scheduled_date) 
WHERE workout_kind = 'override' AND archived_at IS NULL;

-- RULE: Only ONE active plan workout per plan_day
CREATE UNIQUE INDEX idx_unique_plan_per_day
ON workouts (replaces_plan_day_id)
WHERE workout_kind = 'plan' AND archived_at IS NULL;

-- Step 5: Refactor workout_sessions table
-- ============================================================================
-- Tracks in-progress workout state (TikTok scroll)
DROP TABLE IF EXISTS active_workout_sessions CASCADE;

CREATE TABLE workout_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Link to canonical workout
    workout_id UUID NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- Execution state
    current_exercise_index INTEGER NOT NULL DEFAULT 0,
    current_set INTEGER NOT NULL DEFAULT 1,
    total_sets INTEGER NOT NULL DEFAULT 3,
    sets_completed JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Rest timer state
    is_resting BOOLEAN NOT NULL DEFAULT FALSE,
    rest_time_remaining INTEGER,
    rest_time_duration INTEGER,
    rest_end_time TIMESTAMPTZ,
    
    -- Timestamps
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Only one active session per user per workout
CREATE UNIQUE INDEX idx_sessions_user_workout_active ON workout_sessions (user_id, workout_id) 
WHERE completed_at IS NULL;

-- Index for querying active sessions
CREATE INDEX idx_sessions_user_active ON workout_sessions (user_id, completed_at) 
WHERE completed_at IS NULL;

-- Step 7: Create helper functions
-- ============================================================================

-- Function: Get workout for a specific date
CREATE OR REPLACE FUNCTION get_workout_for_date(
    p_user_id UUID,
    p_date DATE
) RETURNS TABLE (
    workout_id UUID,
    workout_kind workout_kind,
    title TEXT,
    estimated_minutes INTEGER,
    exercises_structured JSONB,
    source TEXT
) AS $$
BEGIN
    -- First, check for override
    RETURN QUERY
    SELECT 
        w.id,
        w.workout_kind,
        w.title,
        w.estimated_minutes,
        w.exercises_structured,
        'override'::TEXT as source
    FROM workouts w
    WHERE w.user_id = p_user_id
      AND w.workout_kind = 'override'
      AND w.scheduled_date = p_date
      AND w.archived_at IS NULL
    LIMIT 1;
    
    -- If no override found, check plan workout for that weekday
    IF NOT FOUND THEN
        RETURN QUERY
        SELECT 
            w.id,
            w.workout_kind,
            w.title,
            w.estimated_minutes,
            w.exercises_structured,
            'plan'::TEXT as source
        FROM workouts w
        JOIN plan_days pd ON w.id = pd.base_workout_id
        JOIN workout_plans wp ON pd.plan_id = wp.id
        WHERE wp.user_id = p_user_id
          AND wp.is_active = true
          AND pd.weekday = LOWER(TO_CHAR(p_date, 'Day'))
          AND pd.is_rest_day = false
          AND w.archived_at IS NULL
        LIMIT 1;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function: Get additional workouts for a date (scheduled or unscheduled)
CREATE OR REPLACE FUNCTION get_additional_workouts(
    p_user_id UUID,
    p_date DATE
) RETURNS TABLE (
    workout_id UUID,
    title TEXT,
    estimated_minutes INTEGER,
    exercises_structured JSONB,
    is_scheduled BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        w.id,
        w.title,
        w.estimated_minutes,
        w.exercises_structured,
        (w.scheduled_date = p_date) as is_scheduled
    FROM workouts w
    WHERE w.user_id = p_user_id
      AND w.workout_kind = 'additional'
      AND w.archived_at IS NULL
      AND (
          w.scheduled_date = p_date OR  -- Scheduled for this date
          w.scheduled_date IS NULL      -- Unscheduled (always available)
      )
    ORDER BY 
        (w.scheduled_date = p_date) DESC,  -- Scheduled first
        w.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE;

-- Step 8: Add RLS policies
-- ============================================================================

ALTER TABLE workouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_sessions ENABLE ROW LEVEL SECURITY;

-- Users can only access their own workouts
CREATE POLICY workouts_user_access ON workouts
    FOR ALL USING (auth.uid() = user_id);

-- Users can only access plan_days for their active plan
CREATE POLICY plan_days_user_access ON plan_days
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM workout_plans wp
            WHERE wp.id = plan_days.plan_id
              AND wp.user_id = auth.uid()
        )
    );

-- Users can only access their own sessions
CREATE POLICY sessions_user_access ON workout_sessions
    FOR ALL USING (auth.uid() = user_id);

-- Step 9: Grant permissions
-- ============================================================================

GRANT ALL ON workouts TO authenticated;
GRANT ALL ON plan_days TO authenticated;
GRANT ALL ON workout_sessions TO authenticated;
GRANT EXECUTE ON FUNCTION get_workout_for_date TO authenticated;
GRANT EXECUTE ON FUNCTION get_additional_workouts TO authenticated;

-- Step 10: Create updated_at trigger
-- ============================================================================

CREATE TRIGGER update_workouts_updated_at
    BEFORE UPDATE ON workouts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- =====================================================
-- SECTION 3: ADDITIONAL NOTES
-- =====================================================

-- TABLES REFERENCED IN CODE BUT NOT CREATED HERE:
-- 1. exercises - This table contains the exercise library with embeddings
--    It is referenced by exercise_id in exercise_performance and exercise_history
--    This table was likely seeded separately with exercise data
--
-- 2. durational_plan_overrides - Referenced in backend code (cronJobs.ts, tools.ts)
--    This appears to be an alternative or legacy table name for plan_overrides
--    The code uses a fallback pattern to check both tables
--
-- MISSING TABLE: plan_type column
-- The generatePlan.ts route attempts to insert plan_type into workout_plans
-- but this column does not exist in the schema. This needs to be added if required.

-- RECOMMENDED ADDITIONS:
-- Add plan_type column to workout_plans if needed:
-- ALTER TABLE workout_plans ADD COLUMN IF NOT EXISTS plan_type TEXT;

-- =====================================================
-- END OF COMPILATION
-- =====================================================
