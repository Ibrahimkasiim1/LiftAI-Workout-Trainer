/**
 * Exercise Data Normalizer
 * 
 * Resolves the exercise data structure inconsistency throughout the codebase.
 * Handles multiple naming conventions: exercises_structured, exercisesStructured, structured_exercises
 */

import { ExerciseCard, RawWorkoutData } from '../types/exerciseUnified';

/**
 * Normalizes exercise data from any of the inconsistent formats to the canonical ExerciseCard[] format.
 * 
 * This function handles:
 * - exercises_structured (snake_case - PRIMARY)
 * - exercisesStructured (camelCase)
 * - structured_exercises (alternative snake_case)
 * 
 * @param raw - Raw workout data with potentially mixed naming conventions
 * @returns Normalized array of ExerciseCard objects
 */
export function normalizeExercises(raw: RawWorkoutData | any): ExerciseCard[] {
    if (!raw) return [];

    // Try to extract structured exercises from any of the possible field names
    const structured =
        raw.exercises_structured ||
        raw.exercisesStructured ||
        raw.structured_exercises ||
        [];

    // If it's not an array, return empty array
    if (!Array.isArray(structured)) {
        console.warn('[normalizeExercises] Expected array but got:', typeof structured);
        return [];
    }

    // Map each exercise to ensure consistent field names
    return structured.map((ex: any, index: number) => normalizeExercise(ex, index));
}

/**
 * Normalizes a single exercise object to the ExerciseCard format.
 * 
 * @param ex - Raw exercise object with potentially inconsistent field names
 * @param index - Index of the exercise (used for generating IDs if missing)
 * @returns Normalized ExerciseCard object
 */
export function normalizeExercise(ex: any, index: number = 0): ExerciseCard {
    if (!ex) {
        throw new Error('Cannot normalize null or undefined exercise');
    }

    // Some historical planner payloads nest canonical fields inside fullData.
    // Canonicalize here so the app always receives the same ExerciseCard shape.
    const fullData = ex.fullData && typeof ex.fullData === 'object' ? ex.fullData : null;

    return {
        // ID - generate if missing
        id: ex.id || fullData?.id || `${ex.name || fullData?.name || 'exercise'}-${Date.now()}-${index}`,

        // Name - required field
        name: ex.name || fullData?.name || 'Unknown Exercise',

        // Workout parameters with defaults
        sets: typeof ex.sets === 'number' ? ex.sets : 3,
        reps: ex.reps || '8-12',
        rest_seconds: typeof ex.rest_seconds === 'number' ? ex.rest_seconds : 90,

        // Muscle targeting - handle both naming conventions
        target_muscle: ex.target_muscle || fullData?.target_muscle || ex.target || 'general',
        body_part: ex.body_part || fullData?.body_part || ex.bodyPart || 'general',

        // GIF path - handle both naming conventions
        gif_path: ex.gif_path || fullData?.gif_path || ex.gifPath || null,

        // Other optional fields from ExerciseDetail
        secondary_muscles: ex.secondary_muscles || fullData?.secondary_muscles || null,
        equipment: ex.equipment || fullData?.equipment || null,
        // Clean/disambiguated equipment + enrichment (carry through so the UI can
        // show "Chest Press Machine" instead of raw "leverage machine").
        equipment_canonical: ex.equipment_canonical || fullData?.equipment_canonical || null,
        equipment_display: ex.equipment_display || fullData?.equipment_display || null,
        enrichment: ex.enrichment || fullData?.enrichment || null,
        category: ex.category || fullData?.category || null,
        difficulty: ex.difficulty || fullData?.difficulty || null,
        instructions: ex.instructions || fullData?.instructions || null,
        notes: ex.notes || undefined,
    };
}

/**
 * Normalizes workout day data to ensure exercises_structured is the primary field.
 * 
 * @param raw - Raw workout day data
 * @returns Normalized workout day with exercises_structured as primary field
 */
export function normalizeWorkoutDay(raw: any): any {
    if (!raw) return null;

    const exercises = normalizeExercises(raw);

    return {
        ...raw,
        // Ensure exercises_structured is the primary field
        exercises_structured: exercises,
        // Keep exercises array for backward compatibility (just names)
        exercises: exercises.map(ex => ex.name),
        // Remove the alternative naming conventions to avoid confusion
        exercisesStructured: undefined,
        structured_exercises: undefined,
    };
}

/**
 * Helper to get exercises from any workout object, handling all naming conventions.
 * This is a convenience function for quick access without mutation.
 * 
 * @param workout - Workout object with potentially mixed naming conventions
 * @returns Array of normalized ExerciseCard objects
 */
export function getExercises(workout: any): ExerciseCard[] {
    if (!workout) return [];
    return normalizeExercises(workout);
}

/**
 * Helper to count exercises in a workout, handling all naming conventions.
 * 
 * @param workout - Workout object with potentially mixed naming conventions
 * @returns Number of exercises
 */
export function getExerciseCount(workout: any): number {
    return getExercises(workout).length;
}

/**
 * Validates that all exercises in an array have required fields.
 * 
 * @param exercises - Array of exercises to validate
 * @returns Object with isValid flag and any validation errors
 */
export function validateExercises(exercises: any[]): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!Array.isArray(exercises)) {
        return { isValid: false, errors: ['Exercises must be an array'] };
    }

    exercises.forEach((ex, index) => {
        if (!ex.name) {
            errors.push(`Exercise at index ${index} is missing a name`);
        }
        if (!ex.id) {
            errors.push(`Exercise at index ${index} is missing an ID`);
        }
        if (typeof ex.sets !== 'number' || ex.sets <= 0) {
            errors.push(`Exercise "${ex.name || index}" has invalid sets: ${ex.sets}`);
        }
    });

    return {
        isValid: errors.length === 0,
        errors,
    };
}
