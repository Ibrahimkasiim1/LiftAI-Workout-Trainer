-- ============================================================================
-- LIFTAI WORKOUT ARCHITECTURE REFACTOR
-- ============================================================================
-- Purpose: Enforce clean separation between plan/override/additional workouts
-- Principles:
--   1. One source of truth per concept
--   2. Database enforces business rules via constraints
--   3. No ambiguous table usage
--   4. Explicit intent tracking
-- ============================================================================

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

-- Step 6: Migrate existing data from saved_workouts
-- ============================================================================
-- This migration preserves existing user data with correct classification

-- 6a. Migrate replacement workouts as overrides (with plan_day_id resolution)
-- We need to find the plan_day_id for each replacement based on the date's weekday
INSERT INTO workouts (
    user_id,
    workout_kind,
    created_by,
    title,
    description,
    estimated_minutes,
    exercises_structured,
    scheduled_date,
    replaces_plan_day_id,
    created_at
)
SELECT 
    sw.user_id,
    'override'::workout_kind,
    'adjuster'::workout_created_by,
    sw.workout_name,
    COALESCE(sw.description, sw.note, ''),
    sw.estimated_time,
    COALESCE(sw.exercises_structured, '[]'::jsonb),
    sw.replacement_date,
    pd.id as replaces_plan_day_id,
    sw.created_at
FROM saved_workouts sw
-- Join to find the active workout plan
JOIN workout_plans wp ON wp.user_id = sw.user_id AND wp.is_active = true
-- Join to find the plan_day for the weekday of the replacement_date
JOIN plan_days pd ON pd.plan_id = wp.id 
    AND pd.weekday = LOWER(TRIM(TO_CHAR(sw.replacement_date, 'Day')))
WHERE sw.workout_type = 'replacement_workout' 
  AND sw.replacement_date IS NOT NULL
  AND sw.replacement_date >= CURRENT_DATE - INTERVAL '7 days' -- Only recent replacements
ON CONFLICT DO NOTHING;

-- 6b. Migrate "replacement" workouts that don't have a valid plan_day as additional workouts
-- (These are edge cases where the replacement date doesn't match any plan day)
INSERT INTO workouts (
    user_id,
    workout_kind,
    created_by,
    title,
    description,
    estimated_minutes,
    exercises_structured,
    scheduled_date,
    created_at
)
SELECT 
    sw.user_id,
    'additional'::workout_kind,
    'adjuster'::workout_created_by,
    sw.workout_name || ' (converted)',
    COALESCE(sw.description, sw.note, 'Originally marked as replacement'),
    sw.estimated_time,
    COALESCE(sw.exercises_structured, '[]'::jsonb),
    sw.replacement_date,
    sw.created_at
FROM saved_workouts sw
WHERE sw.workout_type = 'replacement_workout' 
  AND sw.replacement_date IS NOT NULL
  AND sw.replacement_date >= CURRENT_DATE - INTERVAL '7 days'
  AND NOT EXISTS (
      -- Only migrate if we couldn't find a matching plan_day
      SELECT 1 FROM workout_plans wp
      JOIN plan_days pd ON pd.plan_id = wp.id
      WHERE wp.user_id = sw.user_id 
        AND wp.is_active = true
        AND pd.weekday = LOWER(TRIM(TO_CHAR(sw.replacement_date, 'Day')))
  )
ON CONFLICT DO NOTHING;

-- 6c. Migrate additional/extra workouts
INSERT INTO workouts (
    user_id,
    workout_kind,
    created_by,
    title,
    description,
    estimated_minutes,
    exercises_structured,
    scheduled_date,
    created_at
)
SELECT 
    user_id,
    'additional'::workout_kind,
    'chat'::workout_created_by,
    workout_name,
    COALESCE(description, note, ''),
    estimated_time,
    COALESCE(exercises_structured, '[]'::jsonb),
    NULL, -- Additional workouts are unscheduled by default
    created_at
FROM saved_workouts
WHERE workout_type IN ('extra_workout', 'saved_workout', 'quick_workout')
  AND (replacement_date IS NULL OR workout_type != 'replacement_workout')
ON CONFLICT DO NOTHING;

-- 6c. Link plan_days to existing daily_workouts
-- First, create workouts from daily_workouts
WITH plan_workouts AS (
    INSERT INTO workouts (
        user_id,
        workout_kind,
        created_by,
        title,
        description,
        estimated_minutes,
        exercises_structured
    )
    SELECT 
        wp.user_id,
        'plan'::workout_kind,
        'onboarding'::workout_created_by,
        dw.split_day_name,
        COALESCE(dw.notes, ''),
        dw.estimated_time,
        COALESCE(dw.exercises_structured, '[]'::jsonb)
    FROM daily_workouts dw
    JOIN workout_plans wp ON dw.plan_id = wp.id
    WHERE wp.is_active = true
    RETURNING id, title, created_at
),
-- Then create plan_days entries
plan_day_inserts AS (
    INSERT INTO plan_days (
        plan_id,
        weekday,
        label,
        display_order,
        base_workout_id,
        is_rest_day
    )
    SELECT 
        wp.id as plan_id,
        dw.day_of_week,
        dw.split_day_name,
        CASE dw.day_of_week
            WHEN 'monday' THEN 1
            WHEN 'tuesday' THEN 2
            WHEN 'wednesday' THEN 3
            WHEN 'thursday' THEN 4
            WHEN 'friday' THEN 5
            WHEN 'saturday' THEN 6
            WHEN 'sunday' THEN 7
        END,
        pw.id, -- Link to newly created workout
        (dw.split_day_name ILIKE '%rest%' OR COALESCE(array_length(dw.exercises, 1), 0) = 0)
    FROM daily_workouts dw
    JOIN workout_plans wp ON dw.plan_id = wp.id
    JOIN plan_workouts pw ON pw.title = dw.split_day_name
    WHERE wp.is_active = true
    ON CONFLICT (plan_id, weekday) DO NOTHING
    RETURNING id, weekday
)
SELECT COUNT(*) as migrated_plan_days FROM plan_day_inserts;

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

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_workouts_updated_at
    BEFORE UPDATE ON workouts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- Summary of changes:
-- 1. Created canonical 'workouts' table with strict constraints
-- 2. Created 'plan_days' to represent workout plan structure
-- 3. Refactored 'workout_sessions' for clean execution tracking
-- 4. Migrated existing data from saved_workouts and daily_workouts
-- 5. Added database functions for resolution logic
-- 6. Enforced business rules via CHECK constraints and unique indexes
--
-- OLD TABLES (can be archived after verification):
-- - saved_workouts (data migrated to workouts)
-- - daily_workouts (data migrated to workouts + plan_days)
-- - active_workout_sessions (replaced by workout_sessions)
-- ============================================================================
