// src/services/WorkoutService.ts
/**
 * Workout Service
 * 
 * SINGLE SOURCE OF TRUTH for today's workout.
 * Backend-first architecture: All data reads from Supabase ONLY.
 * 
 * NO AsyncStorage.
 * NO local state caching.
 * NO duplicate "getToday" helpers.
 */

import { getLocalDateString } from '../../utils/date';
import { supabase } from '../../utils/supabase';

// ============================================================================
// TYPES — Canonical Today's Workout State
// ============================================================================

export type TodaysWorkoutStatus = 'workout' | 'rest' | 'error' | 'no_plan';

export interface TodaysWorkoutState {
    status: TodaysWorkoutStatus;
    workout: TodaysWorkoutData | null;
    isReplacement: boolean;
    dayOfWeek: string;
    error?: string;
}

export interface TodaysWorkoutData {
    id: string;
    splitName: string;
    exercises: string[];
    exercises_structured: ExerciseDetail[];
    estimatedTime: number;
    note?: string;
}

export interface ExerciseDetail {
    id: string;
    name: string;
    gif_path: string;
    sets: number;
    reps: string;
    rest_seconds: number;
    target_muscle?: string | null;
    body_part?: string | null;
    equipment?: string | null;
    difficulty?: string | null;
}

// ============================================================================
// WORKOUT SERVICE
// ============================================================================

export const WorkoutService = {
    /**
     * resolveToday — THE ONLY function to get today's workout
     * 
     * Priority:
     * 1. Check saved_workouts for replacement (replacement_date == TODAY)
     * 2. Else get from daily_workouts (main plan)
     * 3. If no workout for today → rest day
     * 4. If no plan exists → no_plan status
     * 5. On any error → error status (FAIL LOUDLY)
     */
    async resolveToday(userId: string): Promise<TodaysWorkoutState> {
        // Use the DEVICE's local calendar day, not UTC. `dayOfWeek` below is
        // already local, so a UTC `today` here made the replacement-workout
        // lookup disagree with the main-plan lookup across the UTC/local
        // midnight gap (e.g. a US user in the evening would see the wrong day).
        const today = getLocalDateString();
        const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

        console.log(`WorkoutService.resolveToday() for user ${userId}, day: ${dayOfWeek}`);

        try {
            // STEP 1: Check for replacement workout
            const { data: replacement, error: replacementError } = await supabase
                .from('saved_workouts')
                .select('*')
                .eq('user_id', userId)
                .eq('replacement_date', today)
                .eq('workout_type', 'replacement_workout')
                .maybeSingle();

            if (replacementError) {
                console.error('Error checking replacement workout:', replacementError);
                // Non-fatal: continue to main plan
            }

            if (replacement) {
                console.log('Found replacement workout for today');
                return {
                    status: 'workout',
                    workout: {
                        id: replacement.id,
                        splitName: replacement.workout_name || 'Replacement Workout',
                        exercises: replacement.exercises || [],
                        exercises_structured: (replacement.exercises_structured || []) as unknown as ExerciseDetail[],
                        estimatedTime: replacement.estimated_time || 0,
                        note: replacement.note || undefined,
                    },
                    isReplacement: true,
                    dayOfWeek,
                };
            }

            // STEP 2: Get active plan
            const { data: activePlan, error: planError } = await supabase
                .from('workout_plans')
                .select('id')
                .eq('user_id', userId)
                .eq('is_active', true)
                .maybeSingle();

            if (planError) {
                console.error('Error fetching active plan:', planError);
                return {
                    status: 'error',
                    workout: null,
                    isReplacement: false,
                    dayOfWeek,
                    error: `Failed to load workout plan: ${planError.message}`,
                };
            }

            if (!activePlan) {
                console.log('No active workout plan found');
                return {
                    status: 'no_plan',
                    workout: null,
                    isReplacement: false,
                    dayOfWeek,
                };
            }

            // STEP 3: Get today's daily workout
            const { data: dailyWorkout, error: dailyError } = await supabase
                .from('daily_workouts')
                .select('*')
                .eq('plan_id', activePlan.id)
                .eq('day_of_week', dayOfWeek)
                .maybeSingle();

            if (dailyError) {
                console.error('Error fetching daily workout:', dailyError);
                return {
                    status: 'error',
                    workout: null,
                    isReplacement: false,
                    dayOfWeek,
                    error: `Failed to load today's workout: ${dailyError.message}`,
                };
            }

            // STEP 4: Determine if rest day
            if (!dailyWorkout) {
                console.log('No workout scheduled for today — rest day');
                return {
                    status: 'rest',
                    workout: null,
                    isReplacement: false,
                    dayOfWeek,
                };
            }

            // Check if workout data indicates rest day
            const isRestDayByData =
                dailyWorkout.split_day_name?.toLowerCase().includes('rest') ||
                !dailyWorkout.exercises ||
                dailyWorkout.exercises.length === 0;

            if (isRestDayByData) {
                console.log('Workout data indicates rest day');
                return {
                    status: 'rest',
                    workout: null,
                    isReplacement: false,
                    dayOfWeek,
                };
            }

            // STEP 5: Return workout
            console.log(`Found workout for today: ${dailyWorkout.split_day_name}`);
            return {
                status: 'workout',
                workout: {
                    id: dailyWorkout.id,
                    splitName: dailyWorkout.split_day_name || 'Workout',
                    exercises: dailyWorkout.exercises || [],
                    exercises_structured: (dailyWorkout.exercises_structured || []) as unknown as ExerciseDetail[],
                    estimatedTime: dailyWorkout.estimated_time || 0,
                    note: dailyWorkout.notes || undefined,
                },
                isReplacement: false,
                dayOfWeek,
            };

        } catch (error) {
            console.error('WorkoutService.resolveToday() FAILED:', error);
            return {
                status: 'error',
                workout: null,
                isReplacement: false,
                dayOfWeek,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    },

    /**
     * Get the Active Workout Plan (for weekly view)
     */
    async getActivePlan(userId: string) {
        const { data: plan, error: planError } = await supabase
            .from('workout_plans')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .maybeSingle();

        if (planError || !plan) return null;

        const { data: days } = await supabase
            .from('daily_workouts')
            .select('*')
            .eq('plan_id', plan.id)
            .order('day_of_week');

        return { plan, schedule: days };
    },

    /**
     * Log a set (Used in the TikTok UI)
     */
    async logSet(performanceData: {
        user_id: string;
        exercise_name: string;
        weight: number;
        reps: number;
        set_number: number;
    }) {
        return await supabase.from('exercise_performance').insert({
            user_id: performanceData.user_id,
            exercise_name: performanceData.exercise_name,
            weight_used: performanceData.weight,
            reps_completed: performanceData.reps,
            set_number: performanceData.set_number
        });
    }
};
