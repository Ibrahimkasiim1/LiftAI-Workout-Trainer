/**
 * Shared Workout Payload Types
 * 
 * Type contracts for workout data exchanged between backend and frontend.
 * These types ensure consistency and prevent hallucinated or incomplete exercise data.
 * 
 * Extends base types from ./workout.ts with additional backend contract requirements
 */

import { DailyWorkout as BaseDailyWorkout, ExerciseDetail as BaseExerciseDetail, WorkoutPlan as BaseWorkoutPlan } from './workout';

// ============================================================================
// EXERCISE TYPES
// ============================================================================

/**
 * Exercise row used in generated workouts / chat UI.
 * Same as ExerciseDetail; GIF may be null until matched to the exercises table.
 */
export type ExerciseCard = BaseExerciseDetail;

// ============================================================================
// WORKOUT TYPES
// ============================================================================

/**
 * Complete workout payload
 * Used for both generated workouts and daily workouts
 */
export interface WorkoutPayload {
    /** Workout ID */
    id?: string;

    /** Workout name/title */
    workout_name: string;

    /** List of exercise names (legacy format) */
    exercises: string[];

    /** Full structured exercise objects - PREFERRED */
    exercises_structured: ExerciseCard[];

    /** Estimated time in minutes */
    estimated_time: number;

    /** Difficulty level */
    difficulty: 'beginner' | 'intermediate' | 'advanced';

    /** Workout description */
    description?: string;

    /** Workout type classification */
    workout_type?: 'main_plan' | 'replacement_workout' | 'quick_workout' | 'extra_workout';

    /** If replacement, which day it replaces */
    replacement_for_day?: string;

    /** Optional notes */
    note?: string;

    /** Split day name (e.g., "Push", "Pull", "Legs") */
    split_day_name?: string;

    /** Day of week (for main plan workouts) */
    day_of_week?: string;
}

// Re-export base types for convenience
export type { BaseDailyWorkout as DailyWorkout, BaseWorkoutPlan as WorkoutPlan };

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Validate that an object is a valid ExerciseCard
 *
 * Required fields: id, name, gif_path, sets, reps, rest_seconds.
 * Optional new fields are accepted but not required so legacy stored
 * workouts (created before the elite-coach upgrade) still pass validation:
 *   - quick_alternatives?: string[]
 *   - intensity_target?: string
 */
export function isValidExerciseCard(obj: any): obj is ExerciseCard {
    if (
        !obj ||
        typeof obj !== 'object' ||
        typeof obj.id !== 'string' ||
        typeof obj.name !== 'string' ||
        !(obj.gif_path === null || typeof obj.gif_path === 'string') ||
        typeof obj.sets !== 'number' ||
        !(typeof obj.reps === 'string' || typeof obj.reps === 'number') ||
        typeof obj.rest_seconds !== 'number'
    ) {
        return false;
    }

    if (obj.quick_alternatives !== undefined) {
        if (!Array.isArray(obj.quick_alternatives)) return false;
        if (!obj.quick_alternatives.every((alt: unknown) => typeof alt === 'string')) {
            return false;
        }
    }

    if (obj.intensity_target !== undefined && typeof obj.intensity_target !== 'string') {
        return false;
    }

    return true;
}

/**
 * Validate that an object is a valid WorkoutPayload
 */
export function isValidWorkoutPayload(obj: any): obj is WorkoutPayload {
    return (
        obj &&
        typeof obj === 'object' &&
        typeof obj.workout_name === 'string' &&
        Array.isArray(obj.exercises) &&
        Array.isArray(obj.exercises_structured) &&
        obj.exercises_structured.every(isValidExerciseCard) &&
        typeof obj.estimated_time === 'number' &&
        typeof obj.difficulty === 'string'
    );
}

/**
 * Filter out invalid exercises and log warnings
 */
export function sanitizeExercises(exercises: any[]): ExerciseCard[] {
    return exercises.filter((ex, index) => {
        const valid = isValidExerciseCard(ex);
        if (!valid) {
            console.warn(`Invalid exercise at index ${index}:`, {
                hasId: !!ex?.id,
                hasName: !!ex?.name,
                hasGifPath: !!ex?.gif_path,
                hasSets: typeof ex?.sets === 'number',
                hasReps: !!(ex?.reps),
                hasRestSeconds: typeof ex?.rest_seconds === 'number',
            });
        }
        return valid;
    });
}
