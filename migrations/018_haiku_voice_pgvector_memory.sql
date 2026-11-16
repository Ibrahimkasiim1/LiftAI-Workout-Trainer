-- Migration 018: Haiku/Realtime/embedding pricing + voice sessions +
-- pgvector exercise embeddings + categorized long-term memory.
--
-- This migration is structured so each section is idempotent and can be
-- run independently if you want to apply pieces in isolation.
--
-- Apply order: review each section, then run the whole file in Supabase SQL
-- editor. Backfill steps (exercise embeddings) are NOT part of this file —
-- run the backfill script separately after the schema is in place.

-- ============================================================================
-- 1. MODEL PRICING — extend with cache + audio columns, seed new models
-- ============================================================================

-- Add cache + audio price columns. Both nullable so existing OpenAI rows stay
-- valid. usageTracking.ts falls back to standard input rate when cache rates
-- are NULL, so omitting them is safe for non-Anthropic models.
ALTER TABLE model_pricing
    ADD COLUMN IF NOT EXISTS cache_read_price_per_million numeric,
    ADD COLUMN IF NOT EXISTS cache_creation_price_per_million numeric,
    ADD COLUMN IF NOT EXISTS audio_input_price_per_minute numeric,
    ADD COLUMN IF NOT EXISTS audio_output_price_per_minute numeric;

-- Anthropic Claude pricing (USD per 1M tokens).
-- Cache-read = 10% of fresh input; cache-creation = 125% of fresh input.
-- Source: anthropic.com/pricing — verify before deploying production.
-- NOTE: `provider` is NOT NULL on the existing model_pricing schema
-- (see migration 017). All INSERTs below set it explicitly.
INSERT INTO model_pricing (
    model_name,
    provider,
    input_price_per_million,
    output_price_per_million,
    cache_read_price_per_million,
    cache_creation_price_per_million
) VALUES
    ('claude-haiku-4-5-20251001', 'anthropic',  1.00,  5.00,  0.10,  1.25),
    ('claude-sonnet-4-6',         'anthropic',  3.00, 15.00,  0.30,  3.75),
    ('claude-opus-4-7',           'anthropic', 15.00, 75.00,  1.50, 18.75)
ON CONFLICT (model_name) DO UPDATE SET
    provider                         = EXCLUDED.provider,
    input_price_per_million          = EXCLUDED.input_price_per_million,
    output_price_per_million         = EXCLUDED.output_price_per_million,
    cache_read_price_per_million     = EXCLUDED.cache_read_price_per_million,
    cache_creation_price_per_million = EXCLUDED.cache_creation_price_per_million,
    updated_at                       = now();

-- OpenAI Realtime (audio) pricing — billed per minute, not per token.
-- Verify against openai.com/pricing for the exact model snapshot you deploy.
INSERT INTO model_pricing (
    model_name,
    provider,
    input_price_per_million,
    output_price_per_million,
    audio_input_price_per_minute,
    audio_output_price_per_minute
) VALUES
    ('gpt-realtime-mini', 'openai', 0.0, 0.0, 0.010, 0.020),
    ('gpt-realtime',      'openai', 0.0, 0.0, 0.060, 0.240)
ON CONFLICT (model_name) DO UPDATE SET
    provider                      = EXCLUDED.provider,
    audio_input_price_per_minute  = EXCLUDED.audio_input_price_per_minute,
    audio_output_price_per_minute = EXCLUDED.audio_output_price_per_minute,
    updated_at                    = now();

-- OpenAI embeddings — input-only model. Output column is 0.
INSERT INTO model_pricing (
    model_name,
    provider,
    input_price_per_million,
    output_price_per_million
) VALUES
    ('text-embedding-3-small', 'openai', 0.02, 0.0),
    ('text-embedding-3-large', 'openai', 0.13, 0.0)
ON CONFLICT (model_name) DO UPDATE SET
    provider                 = EXCLUDED.provider,
    input_price_per_million  = EXCLUDED.input_price_per_million,
    output_price_per_million = EXCLUDED.output_price_per_million,
    updated_at               = now();

-- ============================================================================
-- 2. VOICE SESSIONS — log Realtime sessions for cost + replay analytics
-- ============================================================================
--
-- Each Realtime session opens a WebRTC channel between the client and OpenAI.
-- We mint an ephemeral token server-side (so the API key never reaches the
-- device), and on session-end the client POSTs durations + transcript so we
-- can accrue cost via record_ai_cost and let the analyst agent reason over
-- emotional signals.

CREATE TABLE IF NOT EXISTS voice_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    model_name      text NOT NULL,
    input_audio_minutes  numeric NOT NULL DEFAULT 0,
    output_audio_minutes numeric NOT NULL DEFAULT 0,
    transcript      text,
    -- Aggregate emotion summary the Realtime model reports (or our own
    -- post-processing). Free-form JSON so we can iterate without migrations.
    emotion_summary jsonb,
    -- Free-form metadata: device, ios/android, app version, etc.
    client_meta     jsonb,
    accrued_cost_usd numeric NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS voice_sessions_user_id_started_at_idx
    ON voice_sessions (user_id, started_at DESC);

ALTER TABLE voice_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_sessions_owner_select ON voice_sessions;
CREATE POLICY voice_sessions_owner_select
    ON voice_sessions FOR SELECT
    USING (auth.uid() = user_id);

-- Backend service-role writes only — never client.
DROP POLICY IF EXISTS voice_sessions_service_write ON voice_sessions;
CREATE POLICY voice_sessions_service_write
    ON voice_sessions FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- 3. PGVECTOR — exercise embeddings for similarity search
-- ============================================================================
--
-- Used by the new `find_similar_exercises` tool and to upgrade the swap-
-- alternatives RPC. Embedding dimension = 1536 to match
-- text-embedding-3-small. If you switch to a different model, drop and
-- recreate the column with matching dimension.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE exercises
    ADD COLUMN IF NOT EXISTS embedding vector(1536),
    ADD COLUMN IF NOT EXISTS embedding_model text,
    ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

-- IVFFlat index is INTENTIONALLY NOT created here. Two reasons:
--   1. The build-time memory ask scales with table size and on Supabase's
--      shared cluster the SQL editor's default `maintenance_work_mem` (32MB)
--      is too small for libraries past a few hundred rows.
--   2. IVFFlat clusters existing vectors at create time. Building it on an
--      empty / mostly-NULL column produces a useless index — you'd have to
--      REINDEX after backfill anyway.
--
-- Run the post-backfill index creator instead (separate file or via MCP):
--
--     SET LOCAL maintenance_work_mem = '256MB';
--     CREATE INDEX IF NOT EXISTS exercises_embedding_idx
--         ON exercises USING ivfflat (embedding vector_cosine_ops)
--         WITH (lists = 100);
--
-- Until the index exists, similarity searches fall back to a sequential
-- scan over the embedding column. That's still <100ms for libraries
-- under ~5k rows, so the migration is fully usable in the meantime.

-- Cosine-similarity search RPC. Used by the new editor/planner tool
-- `find_similar_exercises`. Returns top-N rows whose embedding column is
-- non-null. Filtering by equipment is optional — when supplied, we restrict
-- to a canonical equipment set BEFORE similarity ranking so injury/equipment
-- constraints are honoured.
CREATE OR REPLACE FUNCTION public.match_similar_exercises(
    query_embedding vector(1536),
    match_count int DEFAULT 8,
    equipment_filter text[] DEFAULT NULL,
    avoid_body_parts text[] DEFAULT NULL
)
RETURNS TABLE (
    id text,
    name text,
    equipment text,
    target_muscle text,
    body_part text,
    gif_path text,
    similarity float
)
LANGUAGE sql STABLE AS $$
    SELECT
        e.id::text,
        e.name,
        e.equipment,
        e.target_muscle,
        e.body_part,
        e.gif_path,
        1 - (e.embedding <=> query_embedding) AS similarity
    FROM exercises e
    WHERE e.embedding IS NOT NULL
      AND e.gif_path IS NOT NULL
      AND e.gif_path <> ''
      AND (equipment_filter IS NULL OR e.equipment = ANY(equipment_filter))
      AND (
          avoid_body_parts IS NULL
          OR NOT EXISTS (
              SELECT 1 FROM unnest(avoid_body_parts) AS p
              WHERE lower(coalesce(e.body_part, '')) LIKE '%' || lower(p) || '%'
                 OR lower(coalesce(e.target_muscle, '')) LIKE '%' || lower(p) || '%'
          )
      )
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
$$;

GRANT EXECUTE ON FUNCTION public.match_similar_exercises(vector, int, text[], text[]) TO authenticated, service_role;

-- ============================================================================
-- 4. CATEGORIZED LONG-TERM MEMORY — coach_memories upgrade
-- ============================================================================
--
-- The existing user_profiles.coach_memory JSONB array works for a flat list
-- of facts. Real long-term coaching needs categories so the agent can pull
-- the relevant slice without dumping everything: preferences vs goals vs
-- body changes vs phase-of-training are reasoned about differently.
--
-- This adds a structured table alongside (NOT replacing) the existing
-- flat array — readers can union both sources during a transition window.
-- See backend/src/services/longTermMemory.ts for the read/write API.

CREATE TABLE IF NOT EXISTS coach_memories (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Canonical categories. Add new ones as needed; the agents read by
    -- enumerated category name.
    category        text NOT NULL CHECK (category IN (
        'preference',     -- "dislikes burpees", "prefers morning workouts"
        'goal',           -- "wants to bench 225 by July", "lose 10lb by wedding"
        'injury',         -- structured pain pattern beyond a one-line label
        'body_change',    -- "down 5lb in May", "added 1in chest April→May"
        'training_phase', -- "currently in hypertrophy block 2 of 3"
        'life_context',   -- "travels Mon-Wed for work", "new baby — 30min sessions only"
        'equipment',      -- "got a barbell at home in April"
        'food_pattern'    -- "fasts till noon", "lactose intolerant"
    )),
    fact            text NOT NULL,
    -- 0.0–1.0 confidence in the fact (LLM extraction returns a guess; manual
    -- entries via /chat default to 1.0).
    confidence      numeric NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
    -- Optional expiry — useful for goals tied to a date and training phases.
    expires_at      timestamptz,
    source          text NOT NULL DEFAULT 'memory_extractor', -- 'memory_extractor' | 'manual' | 'analyst' | 'voice'
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    -- Soft delete so cleanup jobs and "user retracted" don't lose history.
    archived_at     timestamptz
);

CREATE INDEX IF NOT EXISTS coach_memories_user_category_idx
    ON coach_memories (user_id, category)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS coach_memories_user_expires_idx
    ON coach_memories (user_id, expires_at)
    WHERE archived_at IS NULL AND expires_at IS NOT NULL;

ALTER TABLE coach_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coach_memories_owner_read ON coach_memories;
CREATE POLICY coach_memories_owner_read
    ON coach_memories FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS coach_memories_service_write ON coach_memories;
CREATE POLICY coach_memories_service_write
    ON coach_memories FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- Helper RPC: return a compact, agent-prompt-ready slice of recent memories
-- per category. Backend uses this instead of multiple SELECTs.
CREATE OR REPLACE FUNCTION public.get_active_coach_memories(
    p_user_id uuid,
    p_per_category int DEFAULT 5
)
RETURNS TABLE (
    category text,
    fact text,
    confidence numeric,
    last_seen_at timestamptz
)
LANGUAGE sql STABLE AS $$
    SELECT category, fact, confidence, last_seen_at
    FROM (
        SELECT
            cm.category,
            cm.fact,
            cm.confidence,
            cm.last_seen_at,
            ROW_NUMBER() OVER (
                PARTITION BY cm.category
                ORDER BY cm.last_seen_at DESC, cm.confidence DESC
            ) AS rn
        FROM coach_memories cm
        WHERE cm.user_id = p_user_id
          AND cm.archived_at IS NULL
          AND (cm.expires_at IS NULL OR cm.expires_at > now())
    ) ranked
    WHERE ranked.rn <= p_per_category
    ORDER BY category, last_seen_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_active_coach_memories(uuid, int) TO authenticated, service_role;
