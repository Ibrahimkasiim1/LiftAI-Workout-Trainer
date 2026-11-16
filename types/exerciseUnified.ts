/**
 * Unified Exercise Type
 * 
 * Single source of truth for exercise data structure across the entire application.
 * Used by frontend, backend, and matches the Supabase exercises table schema.
 */

// ============================================================================
// CORE EXERCISE TYPE (matches Supabase exercises table)
// ============================================================================

export interface ExerciseDetail {
    id: string;
    name: string;
    target_muscle: string | null;
    secondary_muscles: string[] | null;
    equipment: string | null;
    /** Cleaned equipment bucket (e.g. "machine"). From exercises.equipment_canonical. */
    equipment_canonical?: string | null;
    /** User-facing equipment label, disambiguated from the name (e.g. "Chest Press Machine"). Prefer this in UI. */
    equipment_display?: string | null;
    /** AI-generated biomechanics metadata (movement_pattern, mechanics, aliases, …). */
    enrichment?: {
        equipment_canonical?: string;
        equipment_display?: string;
        movement_pattern?: string;
        mechanics?: string;
        force?: string;
        unilateral?: boolean;
        primary_goal?: string;
        joint_friendly?: string[];
        aliases?: string[];
        summary?: string;
    } | null;
    category: string | null;
    body_part: string | null;
    difficulty: string | null;
    instructions: string[] | null;
    gif_path: string | null;

    // Workout-specific fields (for plan generation)
    sets?: number;
    reps?: string | number;
    rest_seconds?: number;
    notes?: string;

    /**
     * Pre-generated alternative exercise names from the same allowed dictionary
     * the planner used. Frontend can offer instant swaps without a backend
     * round-trip. Optional for backward-compat with legacy plans.
     */
    quick_alternatives?: string[];

    /**
     * Auto-regulation target string (RIR / RPE). Examples:
     *   - "2 RIR - stop 2 reps shy of failure"
     *   - "RPE 8"
     *   - "Leave 2 solid reps in the tank"
     * Optional for backward-compat with legacy plans.
     */
    intensity_target?: string;

    /**
     * Short user-facing modification cue set by the planner when this exercise
     * loads or borders a reported injury (e.g. "Shoulder-friendly: press below
     * shoulder height, stop shy of any pinch."). Absent on unrelated exercises.
     */
    injury_note?: string;
}

// ============================================================================
// DATABASE EXERCISE (raw from Supabase)
// ============================================================================

export interface DatabaseExercise {
    id: string;
    name: string;
    target_muscle: string | null;
    secondary_muscles: string[] | null;
    equipment: string | null;
    category: string | null;
    body_part: string | null;
    difficulty: string | null;
    instructions: string[] | null;
    gif_path: string | null;
    description: string | null;
    embedding: string | null;
}

// ============================================================================
// SEARCH RESULT (from Supabase RPC)
// ============================================================================

export interface ExerciseSearchResult {
    id: string;
    name: string;
    target_muscle: string;
    body_part: string;
    equipment: string;
    similarity: number;
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

export function isValidExerciseDetail(obj: unknown): obj is ExerciseDetail {
    if (!obj || typeof obj !== 'object') return false;
    const exercise = obj as Record<string, unknown>;

    return (
        typeof exercise.id === 'string' &&
        typeof exercise.name === 'string' &&
        exercise.name.length > 0
    );
}

export function toExerciseDetail(
    dbExercise: DatabaseExercise | ExerciseSearchResult,
    workoutParams?: { sets?: number; reps?: string | number; rest_seconds?: number }
): ExerciseDetail {
    // Handle search result (partial data)
    if ('similarity' in dbExercise) {
        return {
            id: dbExercise.id,
            name: dbExercise.name,
            target_muscle: dbExercise.target_muscle || null,
            secondary_muscles: null,
            equipment: dbExercise.equipment || null,
            category: null,
            body_part: dbExercise.body_part || null,
            difficulty: null,
            instructions: null,
            gif_path: null,
            sets: workoutParams?.sets ?? 3,
            reps: workoutParams?.reps ?? '8-12',
            rest_seconds: workoutParams?.rest_seconds ?? 90,
        };
    }

    // Handle full database exercise
    return {
        id: dbExercise.id,
        name: dbExercise.name,
        target_muscle: dbExercise.target_muscle,
        secondary_muscles: dbExercise.secondary_muscles,
        equipment: dbExercise.equipment,
        category: dbExercise.category,
        body_part: dbExercise.body_part,
        difficulty: dbExercise.difficulty,
        instructions: dbExercise.instructions,
        gif_path: dbExercise.gif_path,
        sets: workoutParams?.sets ?? 3,
        reps: workoutParams?.reps ?? '8-12',
        rest_seconds: workoutParams?.rest_seconds ?? 90,
    };
}

// ============================================================================
// WORKOUT DAY STRUCTURE
// ============================================================================

/**
 * ExerciseCard - Alias for ExerciseDetail used in workout contexts
 * This provides backward compatibility while using the unified type
 */
export type ExerciseCard = ExerciseDetail;

/**
 * Standardized Workout Day Interface
 * Uses exercises_structured as the PRIMARY source for exercise data.
 */
export interface WorkoutDay {
    id?: string;
    day_name?: string;
    focus?: string;
    exercises: string[];  // For backward compatibility - just exercise names
    exercises_structured: ExerciseCard[];  // PRIMARY source of exercise data
}

/**
 * Raw workout data that might come from various sources
 * with inconsistent naming conventions
 */
export interface RawWorkoutData {
    exercises?: string[];
    exercises_structured?: any[];
    exercisesStructured?: any[];
    structured_exercises?: any[];
    [key: string]: any;
}

// ============================================================================
// GIF URL HELPER
// ============================================================================

export function getExerciseGifUrl(gifPath: string | null, supabaseUrl: string): string | null {
    if (!gifPath) return null;

    // If it's already a full URL, return as-is
    if (gifPath.startsWith('http')) return gifPath;

    // Build Supabase Storage URL
    return `${supabaseUrl}/storage/v1/object/public/exercises/${gifPath}`;
}
