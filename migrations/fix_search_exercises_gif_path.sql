-- =====================================================
-- FIX: search_exercises RPC function to include gif_path
-- =====================================================
-- 
-- ROOT CAUSE: The search_exercises RPC function was not returning
-- the gif_path column, causing all exercises to fail strict validation.
--
-- This migration updates the function to include gif_path in the return type.
--
-- Run this in Supabase SQL Editor to apply the fix.
--
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
-- VERIFICATION QUERY
-- =====================================================
-- Run this after applying the migration to verify the fix:
--
-- SELECT * FROM search_exercises(
--     '[0.1, 0.2, ...]'::vector(1536),  -- your actual embedding
--     5,
--     0.5,
--     ARRAY['body weight']
-- );
--
-- All returned rows should now have gif_path populated.
-- =====================================================
