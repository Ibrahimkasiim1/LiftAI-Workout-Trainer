/**
 * Legacy Exercise Types
 * 
 * These types are used throughout the application for exercise-related data.
 * For new code, prefer ExerciseDetail from exerciseUnified.ts
 */

// ============================================================================
// EXERCISE BASE TYPE
// ============================================================================

export interface Exercise {
    id: string;
    name: string;
    body_part?: string;
    bodyPart?: string; // Legacy alias
    target?: string;
    target_muscle?: string;
    equipment?: string;
    difficulty?: string;
    instructions?: string[];
    secondary_muscles?: string[];
    gif_url?: string;
    gif_path?: string;
}

// ============================================================================
// EXERCISE PERFORMANCE
// ============================================================================

export interface ExercisePerformance {
    id: string;
    user_id: string;
    exercise_name: string;
    workout_date: Date | string;
    set_number: number;
    reps_completed: number;
    weight_used: number | null;
    comment?: string;
    created_at?: string;
}

export interface ExerciseSet {
    set_number: number;
    reps: number;
    weight?: number;
    completed?: boolean;
    rest_seconds?: number;
}

// ============================================================================
// EXERCISE HISTORY & TRACKING
// ============================================================================

export interface ExerciseHistory {
    exercise_name: string;
    last_weight: number;
    last_reps: number;
    last_date: Date;
    total_workouts: number;
    average_weight: number;
    max_weight: number;
    progression_rate: number; // kg per week
}

export interface PersonalRecord {
    exercise_name: string;
    best_weight: number;
    best_reps_at_weight: number;
    best_volume: number; // weight * reps
    achieved_date: Date | string;
}

// ============================================================================
// SEARCH & FILTERS
// ============================================================================

export interface ExerciseFilters {
    bodyPart?: string;
    equipment?: string[];
    difficulty?: string;
    limit?: number;
}

export interface ExerciseSearchResult {
    id: string;
    name: string;
    body_part: string;
    target_muscle: string;
    equipment: string;
    similarity?: number;
}

// ============================================================================
// RECOMMENDATIONS
// ============================================================================

export interface ExerciseRecommendation {
    exercise: Exercise;
    reason: string;
    score: number;
}

export interface WeightRecommendation {
    exercise_name: string;
    recommended_weight: number;
    based_on: 'last_workout' | 'progressive_overload' | 'default';
    confidence: number;
}

export interface ExerciseAlternative {
    original: string;
    alternatives: Exercise[];
    reason: string;
}
