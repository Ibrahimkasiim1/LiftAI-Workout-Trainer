-- ============================================================================
-- Migration 011: Dedicated coach_memory table
-- ============================================================================
--
-- Replaces (additively) the legacy `user_profiles.coach_memory` JSONB column
-- approach. The new structure is row-per-fact, categorized, and queryable by
-- the multi-agent supervisor stack:
--
--   - `save_core_memory` writes durable facts here (one row per memory).
--   - `fetch_user_context` reads here together with `user_contexts` to render
--     a compact context blob for the LLM system prompt.
--
-- The legacy `user_profiles.coach_memory` column remains untouched for
-- backward compatibility with any existing read paths. New writes go to this
-- table only.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS coach_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (
        category IN (
            'injury',
            'preference',
            'equipment',
            'goal',
            'lifestyle',
            'note'
        )
    ),
    memory_text TEXT NOT NULL CHECK (length(memory_text) BETWEEN 1 AND 1000),
    confidence NUMERIC(3, 2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ
);

COMMENT ON TABLE coach_memory IS 'Durable per-user facts persisted by the AI coach (one row per memory).';
COMMENT ON COLUMN coach_memory.category IS 'Coarse bucket the LLM uses for retrieval/grounding.';
COMMENT ON COLUMN coach_memory.memory_text IS 'Short factual statement (e.g. "left shoulder — overhead pressing irritates").';
COMMENT ON COLUMN coach_memory.confidence IS 'Optional 0-1 score indicating extraction confidence.';
COMMENT ON COLUMN coach_memory.source IS 'Optional provenance tag (e.g. "memory_subgraph", "user_explicit").';
COMMENT ON COLUMN coach_memory.archived_at IS 'When set, treat the memory as soft-deleted but keep history.';

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------

ALTER TABLE coach_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coach_memory: owner read" ON coach_memory;
CREATE POLICY "coach_memory: owner read" ON coach_memory
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "coach_memory: owner insert" ON coach_memory;
CREATE POLICY "coach_memory: owner insert" ON coach_memory
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "coach_memory: owner update" ON coach_memory;
CREATE POLICY "coach_memory: owner update" ON coach_memory
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "coach_memory: owner delete" ON coach_memory;
CREATE POLICY "coach_memory: owner delete" ON coach_memory
    FOR DELETE USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_coach_memory_user_recent
    ON coach_memory(user_id, created_at DESC)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_coach_memory_user_category
    ON coach_memory(user_id, category)
    WHERE archived_at IS NULL;

-- Fuzzy duplicate guard: case-insensitive uniqueness within a category for the
-- same user keeps the LLM from spamming identical facts on repeated turns.
CREATE UNIQUE INDEX IF NOT EXISTS uq_coach_memory_user_category_text_lower
    ON coach_memory(user_id, category, lower(memory_text))
    WHERE archived_at IS NULL;

-- ----------------------------------------------------------------------------
-- updated_at trigger (reuses helper function from migration 004)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_coach_memory_updated_at ON coach_memory;
CREATE TRIGGER update_coach_memory_updated_at
    BEFORE UPDATE ON coach_memory
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
