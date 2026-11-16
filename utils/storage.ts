/**
 * Storage Utility
 * 
 * Functions for saving and loading workouts.
 */

import { getSession, supabase } from './supabase';

/**
 * Types that appear in the Saved / "additional workouts" library.
 * Excludes replacement_workout (reserved for WorkoutService.resolveToday + today's card).
 */
export const SAVED_WORKOUT_LIBRARY_TYPES = [
    'extra_workout',
    'quick_workout',
    'main_plan',
    'main_plan_edit',
] as const;

/** Values allowed by saved_workouts_workout_type_check (migration 005). */
const SAVED_WORKOUT_TYPE_WHITELIST = new Set([
    'main_plan',
    'main_plan_edit',
    'extra_workout',
    'replacement_workout',
    'quick_workout',
]);

/** Coerce LLM/tool strings to a DB-safe workout_type. */
export function normalizeWorkoutTypeForSavedWorkouts(
    raw: string | undefined | null
): string {
    if (raw && SAVED_WORKOUT_TYPE_WHITELIST.has(raw)) {
        return raw;
    }
    if (raw === 'one_off_workout') {
        return 'extra_workout';
    }
    if (raw === 'temporary_addition') {
        return 'extra_workout';
    }
    return 'extra_workout';
}

// ============================================================================
// TYPES
// ============================================================================

export interface SavedWorkout {
    id: string;
    workoutName: string;
    exercises: string[];
    exercises_structured?: any[];
    estimatedTime: number;
    difficulty: string;
    description?: string;
    createdAt: Date;
    workoutType?: string;
    note?: string;
}

// ============================================================================
// SAVE WORKOUT
// ============================================================================

/** Free-tier cap on saved workouts. Pro users are unlimited. */
export const FREE_SAVED_WORKOUTS_LIMIT = 3;

/** Sentinel returned in `error` when the free user has hit the saved-workouts cap. */
export const ERR_SAVED_WORKOUTS_LIMIT = 'pro_required:saved_workouts_limit';

export async function saveWorkout(workout: SavedWorkout): Promise<{
    success: boolean;
    id?: string;
    error?: string;
}> {
    try {
        const session = await getSession();
        if (!session) {
            return { success: false, error: 'Not authenticated' };
        }

        // Free-tier cap check. We read tier_type from user_quotas; if missing or
        // anything other than 'premium', treat as free. Defense-in-depth — the
        // backend save tool enforces the same limit, but checking here lets us
        // present the paywall before a network round-trip.
        const { data: quotaRow } = await supabase
            .from('user_quotas')
            .select('tier_type')
            .eq('user_id', session.user.id)
            .maybeSingle();
        const isFree = (quotaRow?.tier_type ?? 'ad_supported') !== 'premium';
        if (isFree) {
            const { count } = await supabase
                .from('saved_workouts')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', session.user.id);
            if ((count ?? 0) >= FREE_SAVED_WORKOUTS_LIMIT) {
                return { success: false, error: ERR_SAVED_WORKOUTS_LIMIT };
            }
        }

        const { data, error } = await supabase
            .from('saved_workouts')
            .insert({
                user_id: session.user.id,
                workout_name: workout.workoutName,
                workout_type: normalizeWorkoutTypeForSavedWorkouts(
                    workout.workoutType ?? 'extra_workout'
                ),
                exercises: workout.exercises,
                exercises_structured: workout.exercises_structured || [],
                estimated_time: workout.estimatedTime,
                difficulty: workout.difficulty,
                description: workout.description || '',
                note: workout.note || '',
                created_at: new Date().toISOString(),
            })
            .select('id')
            .single();

        if (error) {
            console.error('Error saving workout:', error);
            return { success: false, error: error.message };
        }

        return { success: true, id: data.id };
    } catch (error) {
        console.error('Error in saveWorkout:', error);
        return { success: false, error: String(error) };
    }
}

// ============================================================================
// GET SAVED WORKOUTS
// ============================================================================

export async function getSavedWorkouts(): Promise<{
    workouts: SavedWorkout[];
    error?: string;
}> {
    try {
        const session = await getSession();
        if (!session) {
            return { workouts: [], error: 'Not authenticated' };
        }

        const { data, error } = await supabase
            .from('saved_workouts')
            .select('*')
            .eq('user_id', session.user.id)
            .in('workout_type', [...SAVED_WORKOUT_LIBRARY_TYPES])
            .order('created_at', { ascending: false });

        if (error) {
            return { workouts: [], error: error.message };
        }

        const workouts: SavedWorkout[] = (data || []).map(w => ({
            id: w.id,
            workoutName: w.workout_name,
            exercises: w.exercises || [],
            exercises_structured: Array.isArray(w.exercises_structured) ? w.exercises_structured : undefined,
            estimatedTime: w.estimated_time,
            difficulty: w.difficulty ?? 'intermediate',
            description: w.description ?? undefined,
            createdAt: new Date(w.created_at ?? new Date().toISOString()),
            workoutType: w.workout_type,
            note: w.note ?? undefined,
        }));

        return { workouts };
    } catch (error) {
        console.error('Error getting saved workouts:', error);
        return { workouts: [], error: String(error) };
    }
}

// ============================================================================
// DELETE WORKOUT
// ============================================================================

export async function deleteWorkout(workoutId: string): Promise<{
    success: boolean;
    error?: string;
}> {
    try {
        const { error } = await supabase
            .from('saved_workouts')
            .delete()
            .eq('id', workoutId);

        if (error) {
            return { success: false, error: error.message };
        }

        return { success: true };
    } catch (error) {
        console.error('Error deleting workout:', error);
        return { success: false, error: String(error) };
    }
}

// ============================================================================
// ACTIVE WORKOUT SESSION MANAGEMENT
// ============================================================================

export type WorkoutSessionType = 'main_plan' | 'extra_workout' | 'saved_workout' | 'replacement_workout';

export interface ActiveWorkoutSession {
    id: string;           // Unique session ID
    userId?: string;      // User ID
    workoutId?: string;   // Optional workout ID from DB
    workoutName: string;  // Display name
    workoutType: WorkoutSessionType;
    exercises: string[];  // Exercise names
    structuredExercises?: any[];  // Full ExerciseCard[] objects
    estimatedTime?: number;
    difficulty?: string;
    startedAt: string;

    // Progress tracking
    currentExerciseIndex?: number;
    current_exercise_index?: number;
    current_set?: number;
    total_sets?: number;
    sets_completed?: any[];
    completed_exercise_indexes?: number[];
    /** Every set logged this session, keyed by absolute exercise index. */
    session_set_log?: Record<number, any[]>;

    // Rest timer state
    is_resting?: boolean;
    rest_time_remaining?: number;
    rest_time_duration?: number;
    rest_end_time?: string;

    /** ISO timestamp the CURRENT exercise was started — the top pill's
     *  elapsed clock resumes from this instead of resetting on re-entry. */
    exercise_started_at?: string;
}

/**
 * Get active workout session from AsyncStorage
 * Returns null if no active session exists
 */
export async function getActiveWorkoutSession(type?: WorkoutSessionType): Promise<ActiveWorkoutSession | null> {
    try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const key = type ? `active_workout_${type}` : 'active_workout';
        const sessionData = await AsyncStorage.getItem(key);

        if (!sessionData) return null;

        return JSON.parse(sessionData) as ActiveWorkoutSession;
    } catch (error) {
        console.error('Error getting active workout session:', error);
        return null;
    }
}

/**
 * Save active workout session to AsyncStorage
 */
export async function saveActiveWorkoutSession(session: ActiveWorkoutSession): Promise<void> {
    try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const key = `active_workout_${session.workoutType}`;
        await AsyncStorage.setItem(key, JSON.stringify(session));
    } catch (error) {
        console.error('Error saving active workout session:', error);
    }
}

/**
 * Mark a workout type as completed for today (device-local date). The home
 * card uses this to switch its CTA to "Re-do Workout" after the day's
 * main-plan workout is finished (the active session itself is cleared).
 */
export async function markWorkoutCompletedToday(type: WorkoutSessionType): Promise<void> {
    try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const { getTodayDateString } = await import('./date');
        await AsyncStorage.setItem(`workout_completed_date_${type}`, getTodayDateString());
    } catch (error) {
        console.error('Error marking workout completed:', error);
    }
}

/**
 * True if the given workout type was completed on the device's local "today".
 */
export async function wasWorkoutCompletedToday(type: WorkoutSessionType): Promise<boolean> {
    try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const { getTodayDateString } = await import('./date');
        const stored = await AsyncStorage.getItem(`workout_completed_date_${type}`);
        return stored === getTodayDateString();
    } catch (error) {
        console.error('Error reading workout completion marker:', error);
        return false;
    }
}

/**
 * Clear active workout session from AsyncStorage
 */
export async function clearActiveWorkoutSession(type?: WorkoutSessionType): Promise<void> {
    try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        if (type) {
            const key = `active_workout_${type}`;
            await AsyncStorage.removeItem(key);
        } else {
            // Clear all workout sessions
            const keys = await AsyncStorage.getAllKeys();
            const workoutKeys = keys.filter(k => k.startsWith('active_workout_'));
            await AsyncStorage.multiRemove(workoutKeys);
        }
    } catch (error) {
        console.error('Error clearing active workout session:', error);
    }
}
