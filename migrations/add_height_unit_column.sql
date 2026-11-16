-- =====================================================
-- MIGRATION: Add height_unit column to user_profiles
-- =====================================================
-- This migration safely adds the height_unit column if it doesn't exist
-- Safe to run on existing databases

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
