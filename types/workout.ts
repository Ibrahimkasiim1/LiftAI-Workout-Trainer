/**
 * Workout Types
 * 
 * Shared types for workout plans, daily workouts, and workout sessions
 * Used across frontend (Expo) and backend (Node.js)
 */

// Import canonical ExerciseDetail from unified types
import { ExerciseDetail } from './exerciseUnified';

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export type SplitType = 'full-body' | 'upper-lower' | 'push-pull-legs' | 'bro' | 'custom';
export type FitnessLevel = 'beginner' | 'intermediate' | 'advanced';
export type WorkoutType = 'main_plan' | 'extra_workout' | 'saved_workout' | 'replacement_workout';

// ============================================================================
// WORKOUT PLAN
// ============================================================================

export interface WorkoutPlan {
    id: string;
    user_id: string;
    plan_name: string;
    is_active: boolean;
    created_at: string;
}

export interface DailyWorkout {
    id: string;
    plan_id: string;
    day_of_week: string; // 'monday', 'tuesday', etc.
    split_day_name: string; // 'Push Day', 'Pull Day', 'Upper Body', etc.
    exercises: string[]; // Array of exercise names
    exercises_structured: ExerciseDetail[];
    estimated_time: number; // minutes
    notes?: string;
}

// Re-export ExerciseDetail from unified source
export type { ExerciseDetail };

// ============================================================================
// SAVED WORKOUTS
// ============================================================================

export interface SavedWorkout {
    id: string;
    user_id: string;
    workout_name: string;
    workout_type: WorkoutType;
    exercises: string[];
    exercises_structured: ExerciseDetail[];
    estimated_time: number;
    difficulty: FitnessLevel;
    description?: string;
    note?: string;
    replacement_for?: string; // Day being replaced
    replacement_date?: string; // Date of replacement
    created_at: string;
    updated_at?: string;
}

// ============================================================================
// ACTIVE WORKOUT SESSION
// ============================================================================

export interface ActiveWorkoutSession {
    id: string;
    user_id: string;
    session_id?: string;
    workout_id?: string;
    workout_name: string;
    workout_type: string;
    exercises: string[];
    exercises_structured: ExerciseDetail[];
    estimated_time: number;
    difficulty?: string;

    // Progress tracking
    current_exercise_index?: number;
    current_set?: number;
    total_sets?: number;
    sets_completed?: Record<string, number[]>; // { exerciseName: [reps per set] }

    // Rest timer
    is_resting?: boolean;
    rest_time_duration?: number; // seconds
    rest_time_remaining?: number; // seconds

    started_at?: string;
    updated_at?: string;
}

// ============================================================================
// WORKOUT SESSION (for session management and resumption)
// ============================================================================

/**
 * WorkoutSession - Used for managing and resuming active workouts
 * Augments ActiveWorkoutSession with typed workoutType for better discrimination
 */
export interface WorkoutSession {
    id: string;
    workoutType: WorkoutType;
    workoutName: string;
    exercises: string[];
    structuredExercises: ExerciseDetail[];
    estimatedTime: number;
    startedAt: Date;

    // Optional metadata
    userId?: string;
    workoutId?: string;
    difficulty?: string;

    // Progress tracking
    currentExerciseIndex?: number;
    currentSet?: number;
    totalSets?: number;
    setsCompleted?: Record<string, number[]>;

    // Rest timer
    isResting?: boolean;
    restTimeDuration?: number;
    restTimeRemaining?: number;
}


// ============================================================================
// WORKOUT COMPLETIONS (for progress/streaks)
// ============================================================================

export interface WorkoutCompletion {
    id: string;
    user_id: string;
    completion_date: string; // YYYY-MM-DD
    workout_type: 'workout' | 'rest';
    completed_at: string;
}

// ============================================================================
// WEEKLY SCHEDULE
// ============================================================================

export interface WeeklySchedule {
    plan_id: string;
    plan_name: string;
    days: DailyWorkout[];
}

// ============================================================================
// HELPER TYPES
// ============================================================================

export interface WorkoutFilters {
    difficulty?: FitnessLevel;
    equipment?: string[];
    duration?: number; // max minutes
    type?: WorkoutType;
}

export interface WorkoutProgress {
    workout_id: string;
    exercises_completed: number;
    total_exercises: number;
    sets_completed: number;
    total_sets: number;
    time_elapsed: number; // seconds
}
