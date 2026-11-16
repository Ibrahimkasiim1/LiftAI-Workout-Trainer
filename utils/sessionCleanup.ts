/**
 * Session Cleanup Utility
 * 
 * Handles cleanup of stale workout sessions from both AsyncStorage and Supabase.
 * 
 * ASYNC STORAGE USAGE (ACCEPTABLE):
 * - Active workout sessions are stored in AsyncStorage for fast access
 * - This is temporary UI state (session in progress)
 * - Cleared automatically when workout completes
 * - Cleared manually on app restart if older than 24 hours
 * 
 * DATABASE CLEANUP:
 * - Supabase has cleanup_old_workout_sessions() SQL function
 * - Targets the 'workout_sessions' table (replaces old 'active_workout_sessions')
 * - Removes sessions where completed_at IS NULL and last_activity_at > 24 hours old
 * - Should be called on app startup
 */

import { supabase } from './supabase';

/**
 * PostgreSQL error codes for graceful handling
 * 42883 = undefined_function (function doesn't exist)
 * 42P01 = undefined_table (table doesn't exist)
 */
const SKIPPABLE_ERROR_CODES = ['42883', '42P01'];

/**
 * Call Supabase function to cleanup old workout sessions (>24 hours old)
 * This prevents stale data accumulation in the database
 * 
 * Gracefully handles missing function/table errors in dev environments
 */
export async function cleanupOldWorkoutSessions(): Promise<{
    success: boolean;
    skipped?: boolean;
    error?: string;
}> {
    try {
        console.log('Running database session cleanup...');

        const { error } = await supabase.rpc('cleanup_old_workout_sessions');

        if (error) {
            // Check if this is a skippable error (function or table doesn't exist)
            const errorCode = (error as any).code;
            const errorMessage = error.message?.toLowerCase() || '';
            
            // Expanded skippable conditions to handle various "not found" scenarios
            if (
                SKIPPABLE_ERROR_CODES.includes(errorCode) ||
                errorMessage.includes('does not exist') ||
                errorMessage.includes('undefined_function') ||
                errorMessage.includes('undefined_table') ||
                (errorMessage.includes('relation') && errorMessage.includes('does not exist'))
            ) {
                console.log('Session cleanup skipped (function/table not yet deployed)');
                return { success: true, skipped: true };
            }

            // Log full error details for debugging
            console.error('Error during session cleanup:', {
                message: error.message,
                code: errorCode,
                details: error
            });
            
            // Return success anyway to prevent app startup blocking
            // Session cleanup is a background task and should never block the app
            return { success: true, skipped: true, error: error.message };
        }

        console.log('Session cleanup completed');
        return { success: true };
    } catch (error) {
        // Handle non-Supabase errors gracefully
        const errorMsg = String(error);
        console.log('Session cleanup skipped (error caught):', errorMsg);
        
        // NEVER block app startup due to cleanup errors
        return { success: true, skipped: true, error: errorMsg };
    }
}

/**
 * Cleanup local AsyncStorage sessions that are older than 24 hours
 * This is a client-side cleanup to prevent orphaned session data
 */
export async function cleanupLocalSessions(): Promise<{
    cleaned: number;
    error?: string;
}> {
    try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;

        const keys = await AsyncStorage.getAllKeys();
        const workoutKeys = keys.filter(k => k.startsWith('active_workout_'));

        let cleanedCount = 0;
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

        for (const key of workoutKeys) {
            const data = await AsyncStorage.getItem(key);
            if (!data) continue;

            try {
                const session = JSON.parse(data);
                const startedAt = new Date(session.startedAt).getTime();

                // Remove if older than 24 hours
                if (startedAt < oneDayAgo) {
                    await AsyncStorage.removeItem(key);
                    cleanedCount++;
                    console.log(`Cleaned stale session: ${key}`);
                }
            } catch (parseError) {
                // Invalid JSON - remove it
                await AsyncStorage.removeItem(key);
                cleanedCount++;
                console.log(`Removed invalid session: ${key}`);
            }
        }

        if (cleanedCount > 0) {
            console.log(`Cleaned ${cleanedCount} stale local sessions`);
        }

        return { cleaned: cleanedCount };
    } catch (error) {
        console.error('Error cleaning local sessions:', error);
        return { cleaned: 0, error: String(error) };
    }
}

/**
 * Run full cleanup on app startup
 * Cleans both AsyncStorage and Database
 */
export async function runStartupSessionCleanup(): Promise<void> {
    console.log('Running startup session cleanup...');

    // Run both cleanups in parallel
    const [dbResult, localResult] = await Promise.all([
        cleanupOldWorkoutSessions(),
        cleanupLocalSessions()
    ]);

    if (dbResult.error) {
        console.warn('DB cleanup had errors:', dbResult.error);
    }

    if (localResult.error) {
        console.warn('Local cleanup had errors:', localResult.error);
    }

    console.log('Startup cleanup complete');
}
