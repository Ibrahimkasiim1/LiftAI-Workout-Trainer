/**
 * User Types
 * 
 * Shared types for user profiles and preferences
 * Used across frontend (Expo) and backend (Node.js)
 */

import { FitnessLevel, SplitType } from './workout';

// ============================================================================
// USER PROFILE
// ============================================================================

export interface UserProfile {
    id: string;
    name: string;
    email?: string;

    // Physical attributes
    gender: string; // 'male', 'female', 'other'
    birthday: string;
    height_cm: number;
    height_unit: string; // 'cm' or 'ft'
    weight_kg: number;
    weight_unit: string; // 'kg' or 'lbs'
    goal_weight_kg: number;

    // Fitness profile
    fitness_level: FitnessLevel;
    goal: string; // 'build_muscle', 'lose_weight', 'get_stronger', etc.
    injuries?: string;
    location: string;

    // Workout preferences
    workout_split_type: SplitType;
    workout_days_per_week: number;
    workout_duration_minutes: number;
    selected_workout_days?: DayOfWeek[];
    available_equipment: string[];
    pace: string; // 'slow', 'moderate', 'fast'
    custom_split?: CustomSplit;

    // Onboarding & notifications
    onboarding_completed: boolean;
    onboarding_questions_completed: boolean;
    notifications_enabled: boolean;
    notification_permission_requested: boolean;

    created_at: string;
    updated_at?: string;
}

// ============================================================================
// SUPPLEMENTARY TYPES
// ============================================================================

export type DayOfWeek = {
    day: string; // 'Monday', 'Tuesday', etc.
    enabled: boolean;
};

export interface CustomSplit {
    name: string;
    days: {
        day: string;
        focus: string;
    }[];
}

// ============================================================================
// USER PREFERENCES
// ============================================================================

export interface UserPreferences {
    user_id: string;
    weight_unit: 'kg' | 'lbs';
    height_unit: 'cm' | 'ft';
    theme: 'light' | 'dark' | 'system';
    notifications_enabled: boolean;
    rest_timer_enabled: boolean;
    auto_progress_tracking: boolean;
}

// ============================================================================
// USER STATS
// ============================================================================

export interface UserStats {
    user_id: string;
    total_workouts: number;
    total_exercises: number;
    total_sets: number;
    total_volume: number; // kg or lbs
    current_streak: number;
    longest_streak: number;
    days_active: number;
    average_workout_duration: number; // minutes
    favorite_exercises: string[];
}

// ============================================================================
// USER GOALS & PROGRESS
// ============================================================================

export interface UserGoal {
    id: string;
    user_id: string;
    goal_type: 'weight' | 'strength' | 'endurance' | 'custom';
    target_value: number;
    current_value: number;
    unit: string;
    target_date?: string;
    achieved: boolean;
    created_at: string;
}

export interface GoalProgress {
    goal_id: string;
    progress_percentage: number;
    on_track: boolean;
    estimated_completion_date?: string;
}

// ============================================================================
// SUBSCRIPTION (for premium features)
// ============================================================================

export interface UserSubscription {
    user_id: string;
    plan: 'free' | 'premium' | 'pro';
    status: 'active' | 'cancelled' | 'expired';
    start_date: string;
    end_date?: string;
    auto_renew: boolean;
}
