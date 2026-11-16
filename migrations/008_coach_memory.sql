-- Long-term coach memory facts (JSON array of { text, recorded_at })
-- Used by mutate_user_memory LangGraph tool. Injuries also normalized to JSON array in injuries TEXT.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS coach_memory JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN user_profiles.coach_memory IS 'Durable facts/preferences the AI coach saved via mutate_user_memory tool';

CREATE INDEX IF NOT EXISTS idx_user_profiles_coach_memory_gin
  ON user_profiles USING GIN (coach_memory jsonb_path_ops);
