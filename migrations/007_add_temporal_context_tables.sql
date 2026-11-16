-- ============================================================================
-- Migration 007: Temporal Context & Override Tables
-- ============================================================================
-- 
-- Adds support for temporary workout plan modifications (injuries, vacations)
-- and exercise performance history tracking for progressive overload.
--
-- Tables Added:
-- 1. plan_overrides - Temporary modifications to active plans (auto-expire)
-- 2. user_contexts - Temporary user states (vacation equipment, injuries)
-- 3. exercise_history - Performance tracking for progressive overload
--
-- ============================================================================

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

-- ============================================================================
-- 5. VERIFICATION
-- ============================================================================

-- Verify tables were created
SELECT 
    'Migration 007 Complete' as status,
    COUNT(*) as new_tables
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('plan_overrides', 'user_contexts', 'exercise_history');

-- Verify RLS is enabled
SELECT 
    tablename,
    rowsecurity
FROM pg_tables 
WHERE schemaname = 'public'
AND tablename IN ('plan_overrides', 'user_contexts', 'exercise_history');
