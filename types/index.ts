/**
 * Central Type Exports
 * 
 * Single import point for all types across the application
 * Usage: import { WorkoutPlan, Exercise, UserProfile, ExerciseDetail } from '@/types';
 */

// Workout types (ExerciseDetail is defined here)
export * from './workout';

// Exercise types (legacy - Exercise, ExercisePerformance, etc.)
export {
    Exercise, ExerciseAlternative, ExerciseFilters, ExerciseHistory, ExercisePerformance, ExerciseRecommendation, ExerciseSearchResult, ExerciseSet, PersonalRecord, WeightRecommendation
} from './exercise';

// Unified Exercise types (new helpers and DB types)
export {
    DatabaseExercise, getExerciseGifUrl, isValidExerciseDetail,
    toExerciseDetail, ExerciseSearchResult as UnifiedSearchResult
} from './exerciseUnified';

// User types
export * from './user';

// Chat types
export * from './chat';

// SSE streaming types
export * from './sse';

// Supabase generated types
export * from './supabase';

// Workout payload types (backend/frontend contract)
export * from './workoutPayload';
