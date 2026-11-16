// src/services/ProgressService.ts
/**
 * Progress Service - Unified progress tracking module
 * 
 * Consolidates functionality from:
 * - consistencyTracking.ts (Streaks, Calendars)
 * - progressStats.ts (Aggregates)
 * - progressTracking.ts (Set Logging)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../utils/supabase';

// ============================================================================
// INTERFACES
// ============================================================================

// Streak/Calendar interfaces
export interface WorkoutCompletion {
    id?: string;
    user_id: string;
    completion_date: string; // YYYY-MM-DD format
    workout_type: 'workout' | 'rest';
    completed_at: Date;
}

export interface CalendarDay {
    date: Date;
    dayNumber: number;
    isCurrentMonth: boolean;
    isCompleted: boolean;
    completionType?: 'workout' | 'rest';
}

export interface StreakData {
    currentStreak: number;
    longestStreak: number;
    lastCompletedDate?: Date;
}

export interface CompletionStats {
    monthlyPercentage: number;
    weeklyPercentage: number;
    totalDaysCompleted: number;
    totalDaysInPeriod: number;
}

// Progress Stats interfaces
export interface ProgressStats {
    totalWorkouts: number;
    totalExercises: number;
    totalSets: number;
    totalVolume: number;
    currentStreak: number;
    longestStreak: number;
}

export interface ExerciseSummary {
    exercise_name: string;
    total_sets: number;
    max_weight: number;
    max_reps: number;
    max_volume: number;
    last_performed: Date;
    total_workouts: number;
}

export interface PersonalRecords {
    max_weight: number;
    max_reps: number;
    max_volume: number;
    best_set: {
        weight: number;
        reps: number;
        volume: number;
        date: Date;
    };
}

// Progress Tracking interfaces
export interface ExercisePerformanceLog {
    id?: string;
    exercise_id?: string; // UUID foreign key to exercises table
    exercise_name: string; // LEGACY: Still kept for backwards compatibility & fallback
    set_number: number;
    reps_completed: number;
    weight_used: number;
    workout_date: Date;
}

type ExercisePerformanceRow = {
    id: string;
    exercise_id?: string | null;
    exercise_name: string;
    set_number: number;
    reps_completed: number;
    weight_used: number | null;
    workout_date: string | null;
};

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

export interface WeightRecommendation {
    current_weight: number;
    recommended_weight: number;
    increase_amount: number;
    confidence: 'low' | 'medium' | 'high';
    reasoning: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Helper function to get local date string in YYYY-MM-DD format
 */
const getLocalDateString = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

/**
 * Save performance data to local storage for offline access
 */
const saveToLocalStorage = async (
    userId: string,
    exerciseName: string,
    setNumber: number,
    repsCompleted: number,
    weightUsed: number
): Promise<void> => {
    try {
        const key = `performance_${userId}_${exerciseName}`;
        const existingData = await AsyncStorage.getItem(key);
        const data = existingData ? JSON.parse(existingData) : [];

        data.push({
            set_number: setNumber,
            reps_completed: repsCompleted,
            weight_used: weightUsed,
            timestamp: new Date().toISOString()
        });

        await AsyncStorage.setItem(key, JSON.stringify(data));
    } catch (error) {
        console.error('Error saving to local storage:', error);
    }
};

/**
 * Analyze progression from recent workouts
 */
const analyzeProgression = (workouts: ExercisePerformanceLog[]) => {
    if (workouts.length < 2) return null;

    const weights = workouts.map(w => w.weight_used);
    const isIncreasing = weights.every((weight, i) => i === 0 || weight >= weights[i - 1]);
    const isStable = weights.every(weight => Math.abs(weight - weights[0]) < 2.5);

    return {
        isIncreasing,
        isStable,
        averageWeight: weights.reduce((sum, w) => sum + w, 0) / weights.length,
        weightRange: Math.max(...weights) - Math.min(...weights)
    };
};

/**
 * Calculate smart weight increase
 */
const calculateSmartIncrease = (currentWeight: number, progression: any): number => {
    if (progression.isIncreasing) {
        return 2.5; // Conservative increase
    } else if (progression.isStable) {
        return 1.25; // Small increase
    } else {
        return 0; // No increase if struggling
    }
};

/**
 * Determine confidence level for recommendation
 */
const determineConfidence = (dataPoints: number, progression: any): 'low' | 'medium' | 'high' => {
    if (dataPoints < 3) return 'low';
    if (progression.isStable && dataPoints >= 5) return 'high';
    return 'medium';
};

/**
 * Generate reasoning for weight recommendation
 */
const generateReasoning = (progression: any, increaseAmount: number): string => {
    if (increaseAmount === 0) {
        return "Focus on form and consistency before increasing weight";
    } else if (progression.isIncreasing) {
        return "You've been progressing well! Time for a small increase";
    } else {
        return "Based on your recent performance, a small increase is recommended";
    }
};

// ============================================================================
// PROGRESS SERVICE
// ============================================================================

export const ProgressService = {
    // ==========================================================================
    // WORKOUT COMPLETION LOGGING (from consistencyTracking.ts)
    // ==========================================================================

    /**
     * Log a workout completion for a specific date
     */
    async logWorkoutCompletion(
        userId: string,
        date: Date
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const completionDate = getLocalDateString(date);
            console.log('Logging workout completion for:', completionDate);

            const { error } = await supabase
                .from('workout_completions')
                .upsert({
                    user_id: userId,
                    completion_date: completionDate,
                    workout_type: 'workout',
                    completed_at: new Date().toISOString()
                }, {
                    onConflict: 'user_id,completion_date'
                });

            if (error) {
                console.error('Error logging workout completion:', error);
                return { success: false, error: error.message };
            }

            console.log('Workout completion logged successfully');
            return { success: true };
        } catch (error) {
            console.error('Unexpected error logging workout completion:', error);
            return { success: false, error: 'Failed to log workout completion' };
        }
    },

    /**
     * Log a rest day completion for a specific date
     */
    async logRestDay(
        userId: string,
        date: Date
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const completionDate = getLocalDateString(date);
            console.log('Logging rest day for:', completionDate);

            const { error } = await supabase
                .from('workout_completions')
                .upsert({
                    user_id: userId,
                    completion_date: completionDate,
                    workout_type: 'rest',
                    completed_at: new Date().toISOString()
                }, {
                    onConflict: 'user_id,completion_date'
                });

            if (error) {
                console.error('Error logging rest day:', error);
                return { success: false, error: error.message };
            }

            console.log('Rest day logged successfully');
            return { success: true };
        } catch (error) {
            console.error('Unexpected error logging rest day:', error);
            return { success: false, error: 'Failed to log rest day' };
        }
    },

    /**
     * Check if today should be auto-logged as a rest day
     */
    async shouldAutoLogRestDay(
        userId: string,
        today: Date
    ): Promise<{ shouldLog: boolean; error?: string }> {
        try {
            const todayStr = getLocalDateString(today);

            // Check if already logged today
            const { data, error } = await supabase
                .from('workout_completions')
                .select('id')
                .eq('user_id', userId)
                .eq('completion_date', todayStr)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
                return { shouldLog: false, error: error.message };
            }

            // If no completion found for today, it should be logged as rest day
            return { shouldLog: !data };
        } catch (error) {
            console.error('Error checking rest day status:', error);
            return { shouldLog: false, error: 'Failed to check rest day status' };
        }
    },

    // ==========================================================================
    // CALENDAR DATA (from consistencyTracking.ts)
    // ==========================================================================

    /**
     * Get all completions for a specific month
     */
    async getMonthCompletions(
        userId: string,
        year: number,
        month: number
    ): Promise<{ completions: WorkoutCompletion[]; error?: string }> {
        try {
            console.log(`Fetching completions for ${year}-${month.toString().padStart(2, '0')}`);

            const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
            const endDate = getLocalDateString(new Date(year, month, 0)); // Last day of month (local, not UTC)

            const { data, error } = await supabase
                .from('workout_completions')
                .select('*')
                .eq('user_id', userId)
                .gte('completion_date', startDate)
                .lte('completion_date', endDate)
                .order('completion_date', { ascending: true });

            if (error) {
                console.error('Error fetching month completions:', error);
                return { completions: [], error: error.message };
            }

            const completions: WorkoutCompletion[] = data.map(item => ({
                id: item.id,
                user_id: item.user_id,
                completion_date: item.completion_date,
                workout_type: item.workout_type as 'workout' | 'rest',
                completed_at: new Date(item.completed_at || Date.now())
            }));

            console.log(`Retrieved ${completions.length} completions for month`);
            return { completions };
        } catch (error) {
            console.error('Unexpected error fetching month completions:', error);
            return { completions: [], error: 'Failed to fetch month completions' };
        }
    },

    /**
     * Generate calendar grid for a specific month
     */
    generateMonthGrid(
        year: number,
        month: number,
        completions: WorkoutCompletion[]
    ): CalendarDay[] {
        const firstDay = new Date(year, month - 1, 1);
        const lastDay = new Date(year, month, 0);
        const daysInMonth = lastDay.getDate();

        // Get the day of the week for the first day (0 = Sunday, 1 = Monday, etc.)
        const firstDayOfWeek = firstDay.getDay();

        const calendarDays: CalendarDay[] = [];

        // Add empty cells for days before the first day of the month
        for (let i = 0; i < firstDayOfWeek; i++) {
            const emptyDate = new Date(firstDay);
            emptyDate.setDate(emptyDate.getDate() - (firstDayOfWeek - i));
            calendarDays.push({
                date: emptyDate,
                dayNumber: emptyDate.getDate(),
                isCurrentMonth: false,
                isCompleted: false
            });
        }

        // Add days of the current month
        for (let day = 1; day <= daysInMonth; day++) {
            const currentDate = new Date(year, month - 1, day);
            const dateStr = getLocalDateString(currentDate);

            const completion = completions.find(comp => comp.completion_date === dateStr);

            calendarDays.push({
                date: currentDate,
                dayNumber: day,
                isCurrentMonth: true,
                isCompleted: !!completion,
                completionType: completion?.workout_type
            });
        }

        // Add empty cells for days after the last day of the month
        const remainingCells = 42 - calendarDays.length; // 6 weeks * 7 days = 42 cells
        for (let i = 1; i <= remainingCells; i++) {
            const emptyDate = new Date(lastDay);
            emptyDate.setDate(emptyDate.getDate() + i);
            calendarDays.push({
                date: emptyDate,
                dayNumber: emptyDate.getDate(),
                isCurrentMonth: false,
                isCompleted: false
            });
        }

        return calendarDays;
    },

    // ==========================================================================
    // STREAK CALCULATION (from consistencyTracking.ts)
    // ==========================================================================

    /**
     * Calculate current streak and longest streak
     */
    async calculateStreak(
        userId: string
    ): Promise<{ streak: StreakData; error?: string }> {
        try {
            console.log('Calculating streak for user:', userId);

            // Get all completions ordered by date (most recent first)
            const { data, error } = await supabase
                .from('workout_completions')
                .select('completion_date, workout_type')
                .eq('user_id', userId)
                .order('completion_date', { ascending: false });

            if (error) {
                console.error('Error calculating streak:', error);
                return { streak: { currentStreak: 0, longestStreak: 0 }, error: error.message };
            }

            if (!data || data.length === 0) {
                return { streak: { currentStreak: 0, longestStreak: 0 } };
            }

            const today = new Date();
            const todayStr = getLocalDateString(today);
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = getLocalDateString(yesterday);

            let currentStreak = 0;
            let longestStreak = 0;
            let tempStreak = 0;
            let lastCompletedDate: Date | undefined;

            // Check if today or yesterday was completed (for current streak)
            const hasRecentCompletion = data.some(item =>
                item.completion_date === todayStr || item.completion_date === yesterdayStr
            );

            if (hasRecentCompletion) {
                // Calculate current streak by walking backward over consecutive
                // completed days. Anchor on today when it's already completed,
                // otherwise on yesterday — a day that isn't done *yet* must not
                // break a streak that's still alive through yesterday.
                const completedSet = new Set(data.map(item => item.completion_date));
                const anchor = new Date(today);
                if (!completedSet.has(todayStr)) {
                    anchor.setDate(anchor.getDate() - 1);
                }

                for (let i = 0; i < completedSet.size; i++) {
                    const expectedDate = new Date(anchor);
                    expectedDate.setDate(anchor.getDate() - i);
                    if (completedSet.has(getLocalDateString(expectedDate))) {
                        currentStreak++;
                        if (i === 0) lastCompletedDate = expectedDate;
                    } else {
                        break;
                    }
                }
            }

            // Calculate longest streak
            const sortedDates = data.map(item => item.completion_date).sort();
            tempStreak = 1;

            for (let i = 1; i < sortedDates.length; i++) {
                const currentDate = new Date(sortedDates[i]);
                const previousDate = new Date(sortedDates[i - 1]);
                const dayDiff = (currentDate.getTime() - previousDate.getTime()) / (1000 * 60 * 60 * 24);

                if (dayDiff === 1) {
                    tempStreak++;
                } else {
                    longestStreak = Math.max(longestStreak, tempStreak);
                    tempStreak = 1;
                }
            }
            longestStreak = Math.max(longestStreak, tempStreak);

            const streak: StreakData = {
                currentStreak,
                longestStreak,
                lastCompletedDate: lastCompletedDate ? new Date(lastCompletedDate) : undefined
            };

            console.log('Streak calculated:', streak);
            return { streak };
        } catch (error) {
            console.error('Unexpected error calculating streak:', error);
            return { streak: { currentStreak: 0, longestStreak: 0 }, error: 'Failed to calculate streak' };
        }
    },

    /**
     * Get monthly completion statistics
     */
    async getMonthlyStats(
        userId: string,
        year: number,
        month: number
    ): Promise<{ stats: CompletionStats; error?: string }> {
        try {
            console.log(`Calculating monthly stats for ${year}-${month}`);

            const { completions, error } = await this.getMonthCompletions(userId, year, month);

            if (error) {
                return { stats: { monthlyPercentage: 0, weeklyPercentage: 0, totalDaysCompleted: 0, totalDaysInPeriod: 0 }, error };
            }

            const daysInMonth = new Date(year, month, 0).getDate();
            const totalDaysCompleted = completions.length;
            const monthlyPercentage = Math.round((totalDaysCompleted / daysInMonth) * 100);

            // Calculate weekly percentage (current week)
            const today = new Date();
            const startOfWeek = new Date(today);
            startOfWeek.setDate(today.getDate() - today.getDay());
            const endOfWeek = new Date(startOfWeek);
            endOfWeek.setDate(startOfWeek.getDate() + 6);

            const weekCompletions = completions.filter(completion => {
                const completionDate = new Date(completion.completion_date);
                return completionDate >= startOfWeek && completionDate <= endOfWeek;
            });

            const weeklyPercentage = Math.round((weekCompletions.length / 7) * 100);

            const stats: CompletionStats = {
                monthlyPercentage,
                weeklyPercentage,
                totalDaysCompleted,
                totalDaysInPeriod: daysInMonth
            };

            console.log('Monthly stats calculated:', stats);
            return { stats };
        } catch (error) {
            console.error('Unexpected error calculating monthly stats:', error);
            return { stats: { monthlyPercentage: 0, weeklyPercentage: 0, totalDaysCompleted: 0, totalDaysInPeriod: 0 }, error: 'Failed to calculate monthly stats' };
        }
    },

    // ==========================================================================
    // AGGREGATE STATS (from progressStats.ts)
    // ==========================================================================

    /**
     * Get all exercises performed by user
     */
    async getAllExercisesPerformed(
        userId: string
    ): Promise<{ exercises: string[]; error?: string }> {
        try {
            console.log('Fetching all exercises performed by user');

            const { data, error } = await supabase
                .from('exercise_performance')
                .select('exercise_name')
                .eq('user_id', userId)
                .order('exercise_name');

            if (error) {
                console.error('Error fetching exercises:', error);
                return { exercises: [], error: error.message };
            }

            // Get unique exercise names
            const uniqueExercises = [...new Set(data.map(item => item.exercise_name))];

            console.log('Retrieved', uniqueExercises.length, 'unique exercises');
            return { exercises: uniqueExercises };
        } catch (error) {
            console.error('Unexpected error fetching exercises:', error);
            return { exercises: [], error: 'Failed to fetch exercises' };
        }
    },

    /**
     * Get total number of workouts completed
     */
    async getTotalWorkouts(
        userId: string
    ): Promise<{ total: number; error?: string }> {
        try {
            console.log('Calculating total workouts');

            const { data, error } = await supabase
                .from('workout_completions')
                .select('completion_date')
                .eq('user_id', userId)
                .eq('workout_type', 'workout');

            if (error) {
                console.error('Error fetching workout completions:', error);
                return { total: 0, error: error.message };
            }

            // Count unique workout dates
            const uniqueDates = new Set(data.map(item => item.completion_date));
            const total = uniqueDates.size;

            console.log('Total workouts:', total);
            return { total };
        } catch (error) {
            console.error('Unexpected error calculating total workouts:', error);
            return { total: 0, error: 'Failed to calculate total workouts' };
        }
    },

    /**
     * Get total sets performed (count of all sets logged)
     */
    async getTotalSets(
        userId: string
    ): Promise<{ total: number; error?: string }> {
        try {
            console.log('Calculating total sets');

            const { data, error } = await supabase
                .from('exercise_performance')
                .select('id')
                .eq('user_id', userId);

            if (error) {
                console.error('Error fetching performance data:', error);
                return { total: 0, error: error.message };
            }

            const total = data.length;

            console.log('Total sets:', total);
            return { total };
        } catch (error) {
            console.error('Unexpected error calculating total sets:', error);
            return { total: 0, error: 'Failed to calculate total sets' };
        }
    },

    /**
     * Get total volume lifted (sum of weight * reps for all sets)
     */
    async getTotalVolume(
        userId: string
    ): Promise<{ total: number; error?: string }> {
        try {
            console.log('Calculating total volume lifted');

            const { data, error } = await supabase
                .from('exercise_performance')
                .select('weight_used, reps_completed')
                .eq('user_id', userId);

            if (error) {
                console.error('Error fetching performance data:', error);
                return { total: 0, error: error.message };
            }

            // Calculate total volume (weight * reps for each set)
            const total = data.reduce((sum, set) => {
                const weight = set.weight_used ?? 0;
                const reps = set.reps_completed ?? 0;
                return sum + (weight * reps);
            }, 0);

            console.log('Total volume lifted:', total);
            return { total };
        } catch (error) {
            console.error('Unexpected error calculating total volume:', error);
            return { total: 0, error: 'Failed to calculate total volume' };
        }
    },

    /**
     * Get exercise summary for a specific exercise
     */
    async getExerciseSummary(
        userId: string,
        exerciseName: string
    ): Promise<{ summary: ExerciseSummary | null; error?: string }> {
        try {
            console.log('Getting exercise summary for:', exerciseName);

            const { data, error } = await supabase
                .from('exercise_performance')
                .select('*')
                .eq('user_id', userId)
                .eq('exercise_name', exerciseName)
                .order('workout_date', { ascending: false });

            if (error) {
                console.error('Error fetching exercise data:', error);
                return { summary: null, error: error.message };
            }

            if (data.length === 0) {
                return { summary: null };
            }

            const weights = data.map(item => item.weight_used ?? 0);
            const reps = data.map(item => item.reps_completed ?? 0);
            const volumes = data.map(item => (item.weight_used ?? 0) * (item.reps_completed ?? 0));

            // Count unique workout dates for this exercise
            const uniqueDates = new Set(data.map(item => (item.workout_date ?? '').split('T')[0]).filter(Boolean));

            const summary: ExerciseSummary = {
                exercise_name: exerciseName,
                total_sets: data.length,
                max_weight: Math.max(...weights),
                max_reps: Math.max(...reps),
                max_volume: Math.max(...volumes),
                last_performed: new Date(data[0].workout_date ?? new Date().toISOString()),
                total_workouts: uniqueDates.size
            };

            console.log('Exercise summary calculated:', summary);
            return { summary };
        } catch (error) {
            console.error('Unexpected error getting exercise summary:', error);
            return { summary: null, error: 'Failed to get exercise summary' };
        }
    },

    /**
     * Get personal records for a specific exercise
     */
    async getPersonalRecords(
        userId: string,
        exerciseName: string
    ): Promise<{ records: PersonalRecords | null; error?: string }> {
        try {
            console.log('Getting personal records for:', exerciseName);

            const { data, error } = await supabase
                .from('exercise_performance')
                .select('*')
                .eq('user_id', userId)
                .eq('exercise_name', exerciseName)
                .order('workout_date', { ascending: false });

            if (error) {
                console.error('Error fetching exercise data:', error);
                return { records: null, error: error.message };
            }

            if (data.length === 0) {
                return { records: null };
            }

            const weights = data.map(item => item.weight_used ?? 0);
            const reps = data.map(item => item.reps_completed ?? 0);
            const volumes = data.map(item => (item.weight_used ?? 0) * (item.reps_completed ?? 0));

            const maxWeight = Math.max(...weights);
            const maxReps = Math.max(...reps);
            const maxVolume = Math.max(...volumes);

            // Find the best set (highest volume)
            const bestSetIndex = volumes.indexOf(maxVolume);
            const bestSet = data[bestSetIndex];

            const records: PersonalRecords = {
                max_weight: maxWeight,
                max_reps: maxReps,
                max_volume: maxVolume,
                best_set: {
                    weight: bestSet.weight_used ?? 0,
                    reps: bestSet.reps_completed ?? 0,
                    volume: (bestSet.weight_used ?? 0) * (bestSet.reps_completed ?? 0),
                    date: new Date(bestSet.workout_date ?? new Date().toISOString())
                }
            };

            console.log('Personal records calculated:', records);
            return { records };
        } catch (error) {
            console.error('Unexpected error getting personal records:', error);
            return { records: null, error: 'Failed to get personal records' };
        }
    },

    /**
     * Get comprehensive progress statistics
     */
    async getProgressStats(
        userId: string
    ): Promise<{ stats: ProgressStats; error?: string }> {
        try {
            console.log('Getting comprehensive progress stats');

            // Get all statistics in parallel
            const [totalWorkoutsResult, totalSetsResult, totalVolumeResult, exercisesResult, streakResult] = await Promise.all([
                this.getTotalWorkouts(userId),
                this.getTotalSets(userId),
                this.getTotalVolume(userId),
                this.getAllExercisesPerformed(userId),
                this.calculateStreak(userId)
            ]);

            const stats: ProgressStats = {
                totalWorkouts: totalWorkoutsResult.total,
                totalExercises: exercisesResult.exercises.length,
                totalSets: totalSetsResult.total,
                totalVolume: totalVolumeResult.total,
                currentStreak: streakResult.streak.currentStreak,
                longestStreak: streakResult.streak.longestStreak
            };

            console.log('Progress stats calculated:', stats);
            return { stats };
        } catch (error) {
            console.error('Unexpected error getting progress stats:', error);
            return {
                stats: {
                    totalWorkouts: 0,
                    totalExercises: 0,
                    totalSets: 0,
                    totalVolume: 0,
                    currentStreak: 0,
                    longestStreak: 0
                },
                error: 'Failed to get progress stats'
            };
        }
    },

    // ==========================================================================
    // SET LOGGING (from progressTracking.ts)
    // ==========================================================================

    /**
     * Save a set's performance data
     * 
     * Accepts exercise_id for proper FK tracking
     * Falls back to name if ID not provided (legacy compatibility)
     */
    async saveSetPerformance(
        userId: string,
        exerciseName: string,
        setNumber: number,
        repsCompleted: number,
        weightUsed: number,
        exerciseId?: string // Exercise UUID for proper tracking
    ): Promise<{ success: boolean; id?: string; error?: string }> {
        try {
            console.log('Saving set performance:', {
                exerciseName,
                exerciseId: exerciseId || 'legacy',
                setNumber,
                repsCompleted,
                weightUsed
            });

            const { data, error } = await supabase
                .from('exercise_performance')
                .insert({
                    user_id: userId,
                    exercise_id: exerciseId || null, // Use ID if provided
                    exercise_name: exerciseName, // Keep name for backwards compat
                    set_number: setNumber,
                    reps_completed: repsCompleted,
                    weight_used: weightUsed,
                    workout_date: new Date().toISOString()
                })
                .select('id')
                .single();

            if (error) {
                console.error('Error saving set performance:', error);
                return { success: false, error: error.message };
            }

            // Also save to AsyncStorage for offline access
            await saveToLocalStorage(userId, exerciseName, setNumber, repsCompleted, weightUsed);

            console.log('Set performance saved successfully');
            return { success: true, id: data?.id };
        } catch (error) {
            console.error('Unexpected error saving set performance:', error);
            return { success: false, error: 'Failed to save performance data' };
        }
    },

    /**
     * Correct a previously logged set (mis-logged weight/reps).
     * Scoped to the owning user; weight is in kg (database unit).
     */
    async updateSetPerformance(
        userId: string,
        performanceId: string,
        repsCompleted: number,
        weightUsedKg: number
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const { error } = await supabase
                .from('exercise_performance')
                .update({
                    reps_completed: repsCompleted,
                    weight_used: weightUsedKg,
                })
                .eq('id', performanceId)
                .eq('user_id', userId);

            if (error) {
                console.error('Error updating set performance:', error);
                return { success: false, error: error.message };
            }
            return { success: true };
        } catch (error) {
            console.error('Unexpected error updating set performance:', error);
            return { success: false, error: 'Failed to update performance data' };
        }
    },

    /**
     * Get exercise history for a specific exercise
     */
    async getExerciseHistory(
        userId: string,
        exerciseName: string,
        limit: number = 20
    ): Promise<{ history: ExercisePerformanceLog[]; error?: string }> {
        try {
            console.log('Fetching exercise history for:', exerciseName);

            const { data, error } = await supabase
                .from('exercise_performance')
                .select('*')
                .eq('user_id', userId)
                .eq('exercise_name', exerciseName)
                .order('workout_date', { ascending: false })
                .limit(limit);

            if (error) {
                console.error('Error fetching exercise history:', error);
                return { history: [], error: error.message };
            }

            const rows = (data ?? []) as ExercisePerformanceRow[];
            const history: ExercisePerformanceLog[] = rows.map(item => ({
                id: item.id,
                exercise_id: item.exercise_id ?? undefined,
                exercise_name: item.exercise_name,
                set_number: item.set_number,
                reps_completed: item.reps_completed,
                weight_used: item.weight_used ?? 0,
                workout_date: new Date(item.workout_date || Date.now())
            }));

            console.log('Retrieved', history.length, 'performance records');
            return { history };
        } catch (error) {
            console.error('Unexpected error fetching exercise history:', error);
            return { history: [], error: 'Failed to fetch exercise history' };
        }
    },

    /**
     * Get the last workout data for an exercise
     */
    async getLastWorkoutData(
        userId: string,
        exerciseName: string
    ): Promise<{ data: ExercisePerformanceLog | null; error?: string }> {
        try {
            console.log('Getting last workout data for:', exerciseName);

            const { data, error } = await supabase
                .from('exercise_performance')
                .select('*')
                .eq('user_id', userId)
                .eq('exercise_name', exerciseName)
                .order('workout_date', { ascending: false })
                .limit(1)
                .single();

            if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
                console.error('Error fetching last workout data:', error);
                return { data: null, error: error.message };
            }

            if (!data) {
                console.log('No previous data found for:', exerciseName);
                return { data: null };
            }

            const row = data as ExercisePerformanceRow;
            const lastData: ExercisePerformanceLog = {
                id: row.id,
                exercise_id: row.exercise_id ?? undefined,
                exercise_name: row.exercise_name,
                set_number: row.set_number,
                reps_completed: row.reps_completed,
                weight_used: row.weight_used ?? 0,
                workout_date: new Date(row.workout_date || Date.now())
            };

            console.log('Retrieved last workout data:', lastData);
            return { data: lastData };
        } catch (error) {
            console.error('Unexpected error fetching last workout data:', error);
            return { data: null, error: 'Failed to fetch last workout data' };
        }
    },

    /**
     * Calculate weight recommendation based on historical data
     */
    async calculateWeightRecommendation(
        userId: string,
        exerciseName: string,
        currentWeight: number
    ): Promise<{ recommendation: WeightRecommendation | null; error?: string }> {
        try {
            console.log('Calculating weight recommendation for:', exerciseName);

            const { history, error } = await this.getExerciseHistory(userId, exerciseName, 10);

            if (error || history.length < 2) {
                console.log('Insufficient data for recommendations');
                return { recommendation: null };
            }

            // Analyze progression over last 3 workouts
            const recentWorkouts = history.slice(0, 3);
            const progression = analyzeProgression(recentWorkouts);

            if (!progression) {
                return { recommendation: null };
            }

            const increaseAmount = calculateSmartIncrease(currentWeight, progression);
            const recommendedWeight = currentWeight + increaseAmount;

            const recommendation: WeightRecommendation = {
                current_weight: currentWeight,
                recommended_weight: recommendedWeight,
                increase_amount: increaseAmount,
                confidence: determineConfidence(history.length, progression),
                reasoning: generateReasoning(progression, increaseAmount)
            };

            console.log('Weight recommendation calculated:', recommendation);
            return { recommendation };
        } catch (error) {
            console.error('Error calculating weight recommendation:', error);
            return { recommendation: null, error: 'Failed to calculate recommendation' };
        }
    },

    /**
     * Check if user has completed their first cycle of the split
     */
    async hasCompletedFirstCycle(
        userId: string,
        splitDays: string[]
    ): Promise<{ completed: boolean; error?: string }> {
        try {
            console.log('Checking if user completed first cycle');

            // Get user's workout plan to determine split days
            const { data: planData, error: planError } = await supabase
                .from('workout_plans')
                .select('id')
                .eq('user_id', userId)
                .eq('is_active', true)
                .single();

            if (planError || !planData) {
                return { completed: false };
            }

            // Check if user has performance data for all split days
            const { data: performanceData, error: perfError } = await supabase
                .from('exercise_performance')
                .select('exercise_name, workout_date')
                .eq('user_id', userId)
                .gte('workout_date', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()); // Last 7 days

            if (perfError || !performanceData || performanceData.length === 0) {
                return { completed: false };
            }

            // Count unique workout dates
            const uniqueDates = new Set(performanceData.filter(p => p.workout_date).map(p => p.workout_date!.split('T')[0]));
            const completed = uniqueDates.size >= splitDays.length;

            console.log('First cycle completion status:', completed);
            return { completed };
        } catch (error) {
            console.error('Error checking cycle completion:', error);
            return { completed: false, error: 'Failed to check cycle completion' };
        }
    },

    /**
     * Get exercise history summary
     */
    async getExerciseHistorySummary(
        userId: string,
        exerciseName: string
    ): Promise<{ summary: ExerciseHistory | null; error?: string }> {
        try {
            const { history, error } = await this.getExerciseHistory(userId, exerciseName, 50);

            if (error || history.length === 0) {
                return { summary: null };
            }

            const weights = history.map(h => h.weight_used);
            const maxWeight = Math.max(...weights);
            const avgWeight = weights.reduce((sum, w) => sum + w, 0) / weights.length;

            // Calculate progression rate (kg per week)
            const firstWorkout = history[history.length - 1];
            const lastWorkout = history[0];
            const weeksDiff = (lastWorkout.workout_date.getTime() - firstWorkout.workout_date.getTime()) / (7 * 24 * 60 * 60 * 1000);
            const progressionRate = weeksDiff > 0 ? (lastWorkout.weight_used - firstWorkout.weight_used) / weeksDiff : 0;

            const summary: ExerciseHistory = {
                exercise_name: exerciseName,
                last_weight: lastWorkout.weight_used,
                last_reps: lastWorkout.reps_completed,
                last_date: lastWorkout.workout_date,
                total_workouts: new Set(history.map(h => h.workout_date.toDateString())).size,
                average_weight: avgWeight,
                max_weight: maxWeight,
                progression_rate: progressionRate
            };

            return { summary };
        } catch (error) {
            console.error('Error getting exercise history summary:', error);
            return { summary: null, error: 'Failed to get exercise history summary' };
        }
    }
};

// ============================================================================
// STANDALONE EXPORTS (for backward compatibility)
// ============================================================================

// From consistencyTracking.ts
export const logWorkoutCompletion = ProgressService.logWorkoutCompletion.bind(ProgressService);
export const logRestDay = ProgressService.logRestDay.bind(ProgressService);
export const shouldAutoLogRestDay = ProgressService.shouldAutoLogRestDay.bind(ProgressService);
export const getMonthCompletions = ProgressService.getMonthCompletions.bind(ProgressService);
export const generateMonthGrid = ProgressService.generateMonthGrid.bind(ProgressService);
export const calculateStreak = ProgressService.calculateStreak.bind(ProgressService);
export const getMonthlyStats = ProgressService.getMonthlyStats.bind(ProgressService);

// From progressStats.ts
export const getAllExercisesPerformed = ProgressService.getAllExercisesPerformed.bind(ProgressService);
export const getTotalWorkouts = ProgressService.getTotalWorkouts.bind(ProgressService);
export const getTotalSets = ProgressService.getTotalSets.bind(ProgressService);
export const getTotalVolume = ProgressService.getTotalVolume.bind(ProgressService);
export const getExerciseSummary = ProgressService.getExerciseSummary.bind(ProgressService);
export const getPersonalRecords = ProgressService.getPersonalRecords.bind(ProgressService);
export const getProgressStats = ProgressService.getProgressStats.bind(ProgressService);

// From progressTracking.ts
export const saveSetPerformance = ProgressService.saveSetPerformance.bind(ProgressService);
export const updateSetPerformance = ProgressService.updateSetPerformance.bind(ProgressService);
export const getExerciseHistory = ProgressService.getExerciseHistory.bind(ProgressService);
export const getLastWorkoutData = ProgressService.getLastWorkoutData.bind(ProgressService);
export const calculateWeightRecommendation = ProgressService.calculateWeightRecommendation.bind(ProgressService);
export const hasCompletedFirstCycle = ProgressService.hasCompletedFirstCycle.bind(ProgressService);
export const getExerciseHistorySummary = ProgressService.getExerciseHistorySummary.bind(ProgressService);

// ============================================================================
// PROGRESS DASHBOARD HELPERS (added for new Progress UI)
// ============================================================================

export interface WeeklyWorkoutProgress {
    completed: number;
    target: number;
    weekStart: Date;
    weekEnd: Date;
}

export interface SparklinePoint {
    date: string; // YYYY-MM-DD
    value: number; // max weight (kg) for that workout day, or 0 if bodyweight only (then reps)
    isBodyweight: boolean;
}

export interface MuscleGroupSlice {
    muscle: string;
    sets: number;
}

export interface ExerciseSeriesPoint {
    date: string; // YYYY-MM-DD
    oneRm: number; // estimated 1RM (Epley) — workout-day max
    volume: number; // sum(weight*reps) for that workout day
    isBodyweight: boolean;
}

export interface HeatmapCell {
    date: string; // YYYY-MM-DD
    intensity: 0 | 1 | 2 | 3 | 4;
    setsCount: number;
}

const startOfWeek = (d: Date): Date => {
    const day = d.getDay(); // 0 = Sunday
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    out.setDate(out.getDate() - day);
    return out;
};

const dayKey = (iso: string | Date): string => {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return getLocalDateString(d);
};

/**
 * Weekly workout progress — completed workouts this week vs target from active plan.
 * Target = number of non-rest days in user's active plan (fallback 5).
 */
export async function getWeeklyWorkoutProgress(userId: string): Promise<WeeklyWorkoutProgress> {
    const now = new Date();
    const weekStart = startOfWeek(now);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const startStr = getLocalDateString(weekStart);
    const endStr = getLocalDateString(weekEnd);

    const [{ data: completions }, { data: profileRow }] = await Promise.all([
        supabase
            .from('workout_completions')
            .select('completion_date, workout_type')
            .eq('user_id', userId)
            .eq('workout_type', 'workout')
            .gte('completion_date', startStr)
            .lte('completion_date', endStr),
        supabase
            .from('user_profiles')
            .select('workout_days_per_week, selected_workout_days')
            .eq('id', userId)
            .maybeSingle(),
    ]);

    let target = 5;
    if (profileRow) {
        const days = (profileRow as any).workout_days_per_week;
        const selected = (profileRow as any).selected_workout_days;
        if (Array.isArray(selected) && selected.length > 0) target = selected.length;
        else if (typeof days === 'number' && days > 0) target = days;
    }

    return {
        completed: completions?.length ?? 0,
        target,
        weekStart,
        weekEnd,
    };
}

/**
 * Sparkline series for an exercise — last N workout days, oldest→newest.
 * Uses max weight per day (kg). For bodyweight-only exercises, falls back to max reps.
 */
export async function getExerciseSparklineData(
    userId: string,
    exerciseName: string,
    limitDays = 8,
): Promise<SparklinePoint[]> {
    const { data, error } = await supabase
        .from('exercise_performance')
        .select('weight_used, reps_completed, workout_date')
        .eq('user_id', userId)
        .eq('exercise_name', exerciseName)
        .order('workout_date', { ascending: false })
        .limit(200);

    if (error || !data) return [];

    // Group by day
    const perDay = new Map<string, { maxWeight: number; maxReps: number; anyWeight: boolean }>();
    for (const row of data) {
        if (!row.workout_date) continue;
        const k = dayKey(row.workout_date);
        const w = row.weight_used ?? 0;
        const r = row.reps_completed ?? 0;
        const cur = perDay.get(k) ?? { maxWeight: 0, maxReps: 0, anyWeight: false };
        cur.maxWeight = Math.max(cur.maxWeight, w);
        cur.maxReps = Math.max(cur.maxReps, r);
        if (w > 0) cur.anyWeight = true;
        perDay.set(k, cur);
    }

    const sorted = [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const recent = sorted.slice(-limitDays);
    return recent.map(([date, v]) => ({
        date,
        value: v.anyWeight ? v.maxWeight : v.maxReps,
        isBodyweight: !v.anyWeight,
    }));
}

/**
 * Muscle group breakdown for the trailing N days (default 7).
 * Joins exercise_performance rows to exercises via exercise_id to get target_muscle.
 * Falls back to bucketing by exercise_name lowercase keyword if no FK match.
 */
export async function getMuscleGroupBreakdown(
    userId: string,
    days = 7,
): Promise<MuscleGroupSlice[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await supabase
        .from('exercise_performance')
        .select('exercise_id, exercise_name, workout_date')
        .eq('user_id', userId)
        .gte('workout_date', since.toISOString());

    if (error || !data || data.length === 0) return [];

    const ids = [...new Set(data.map((r: any) => r.exercise_id).filter(Boolean))] as string[];
    const idToMuscle = new Map<string, string>();

    if (ids.length > 0) {
        const { data: exs } = await supabase
            .from('exercises')
            .select('id, target_muscle, body_part')
            .in('id', ids);
        for (const e of exs || []) {
            const m = (e as any).target_muscle || (e as any).body_part || 'other';
            idToMuscle.set((e as any).id, String(m).toLowerCase());
        }
    }

    const counts = new Map<string, number>();
    for (const row of data as any[]) {
        let muscle = row.exercise_id ? idToMuscle.get(row.exercise_id) : null;
        if (!muscle) muscle = bucketByName(row.exercise_name);
        counts.set(muscle, (counts.get(muscle) ?? 0) + 1);
    }

    return [...counts.entries()]
        .map(([muscle, sets]) => ({ muscle, sets }))
        .sort((a, b) => b.sets - a.sets);
}

function bucketByName(name: string): string {
    const n = (name || '').toLowerCase();
    if (/(bench|chest|push.?up|fly)/.test(n)) return 'chest';
    if (/(squat|lunge|leg press|quad)/.test(n)) return 'quads';
    if (/(deadlift|rdl|hinge|hamstring|leg curl)/.test(n)) return 'hamstrings';
    if (/(row|pull.?up|lat|pulldown)/.test(n)) return 'back';
    if (/(curl|biceps)/.test(n)) return 'biceps';
    if (/(tricep|dip|skull|pushdown)/.test(n)) return 'triceps';
    if (/(shoulder|press|lateral|delt|ohp)/.test(n)) return 'shoulders';
    if (/(calf|raise)/.test(n)) return 'calves';
    if (/(ab|crunch|plank|core)/.test(n)) return 'core';
    if (/(glute|hip thrust)/.test(n)) return 'glutes';
    return 'other';
}

/**
 * Detail series for an exercise: per workout-day max-1RM and total volume.
 * Sorted oldest→newest. Used by Analyze tab Bezier chart.
 */
export async function getExerciseDetailSeries(
    userId: string,
    exerciseName: string,
    limitDays = 30,
): Promise<ExerciseSeriesPoint[]> {
    const { data, error } = await supabase
        .from('exercise_performance')
        .select('weight_used, reps_completed, workout_date')
        .eq('user_id', userId)
        .eq('exercise_name', exerciseName)
        .order('workout_date', { ascending: false })
        .limit(500);

    if (error || !data) return [];

    const perDay = new Map<string, { oneRm: number; volume: number; anyWeight: boolean; maxReps: number }>();
    for (const row of data as any[]) {
        if (!row.workout_date) continue;
        const k = dayKey(row.workout_date);
        const w = row.weight_used ?? 0;
        const r = row.reps_completed ?? 0;
        const epley = w > 0 && r > 0 ? w * (1 + r / 30) : 0;
        const vol = w * r;
        const cur = perDay.get(k) ?? { oneRm: 0, volume: 0, anyWeight: false, maxReps: 0 };
        cur.oneRm = Math.max(cur.oneRm, epley);
        cur.volume += vol;
        if (w > 0) cur.anyWeight = true;
        cur.maxReps = Math.max(cur.maxReps, r);
        perDay.set(k, cur);
    }

    const sorted = [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const recent = sorted.slice(-limitDays);
    return recent.map(([date, v]) => ({
        date,
        oneRm: v.anyWeight ? Math.round(v.oneRm * 10) / 10 : v.maxReps,
        volume: v.anyWeight ? Math.round(v.volume) : v.maxReps,
        isBodyweight: !v.anyWeight,
    }));
}

/**
 * Activity heatmap — last N weeks of intensity per day.
 * Intensity is bucketed from sets count + workout completion presence.
 */
export async function getActivityHeatmap(userId: string, weeks = 12): Promise<HeatmapCell[]> {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const start = new Date(today);
    start.setDate(start.getDate() - (weeks * 7 - 1));
    start.setHours(0, 0, 0, 0);

    const startStr = getLocalDateString(start);
    const endStr = getLocalDateString(today);

    const [perfRes, compRes] = await Promise.all([
        supabase
            .from('exercise_performance')
            .select('workout_date')
            .eq('user_id', userId)
            .gte('workout_date', start.toISOString()),
        supabase
            .from('workout_completions')
            .select('completion_date, workout_type')
            .eq('user_id', userId)
            .gte('completion_date', startStr)
            .lte('completion_date', endStr),
    ]);

    const setsByDay = new Map<string, number>();
    for (const r of perfRes.data || []) {
        if (!(r as any).workout_date) continue;
        const k = dayKey((r as any).workout_date);
        setsByDay.set(k, (setsByDay.get(k) ?? 0) + 1);
    }
    const completionByDay = new Map<string, string>();
    for (const r of compRes.data || []) {
        completionByDay.set((r as any).completion_date, (r as any).workout_type);
    }

    const cells: HeatmapCell[] = [];
    const cursor = new Date(start);
    while (cursor <= today) {
        const k = getLocalDateString(cursor);
        const sets = setsByDay.get(k) ?? 0;
        const hasCompletion = completionByDay.get(k);
        let intensity: 0 | 1 | 2 | 3 | 4 = 0;
        if (sets >= 25) intensity = 4;
        else if (sets >= 15) intensity = 3;
        else if (sets >= 6) intensity = 2;
        else if (sets >= 1) intensity = 1;
        else if (hasCompletion === 'workout') intensity = 1;
        cells.push({ date: k, intensity, setsCount: sets });
        cursor.setDate(cursor.getDate() + 1);
    }
    return cells;
}

// ============================================================================
// WEEKLY VOLUME (for the Progress "Weekly Volume" bar card)
// ============================================================================

export interface WeeklyVolumePoint {
    /** Short label for the bar, e.g. "May 12" (week start). */
    label: string;
    /** Total tonnage for the week in kg (sum of weight × reps). */
    volumeKg: number;
}

export interface WeeklyVolumeSeries {
    points: WeeklyVolumePoint[];
    /** % change of the latest week vs the previous week (null if no baseline). */
    deltaPct: number | null;
    /** True when the latest week is the highest-volume week in the series. */
    latestIsRecord: boolean;
}

/**
 * Total training volume bucketed into rolling 7-day weeks ending today.
 * Powers the Weekly Volume bar chart on the Progress tab.
 */
export async function getWeeklyVolumeSeries(
    userId: string,
    weeks = 7
): Promise<WeeklyVolumeSeries> {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - weeks * 7 + 1);
    start.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
        .from('exercise_performance')
        .select('workout_date, weight_used, reps_completed')
        .eq('user_id', userId)
        .gte('workout_date', start.toISOString());

    if (error) {
        console.error('Weekly volume query failed:', error);
        return { points: [], deltaPct: null, latestIsRecord: false };
    }

    const buckets = new Array<number>(weeks).fill(0);
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    for (const row of data || []) {
        const r = row as { workout_date?: string; weight_used?: number; reps_completed?: number };
        if (!r.workout_date) continue;
        const t = new Date(r.workout_date).getTime();
        const idx = Math.floor((t - start.getTime()) / msPerWeek);
        if (idx < 0 || idx >= weeks) continue;
        buckets[idx] += (r.weight_used ?? 0) * (r.reps_completed ?? 0);
    }

    const points: WeeklyVolumePoint[] = buckets.map((volumeKg, i) => {
        const weekStart = new Date(start.getTime() + i * msPerWeek);
        return {
            label: weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            volumeKg,
        };
    });

    const latest = points[points.length - 1]?.volumeKg ?? 0;
    const prev = points[points.length - 2]?.volumeKg ?? 0;
    const deltaPct = prev > 0 ? Math.round(((latest - prev) / prev) * 100) : null;
    const maxOther = Math.max(0, ...points.slice(0, -1).map((p) => p.volumeKg));
    const latestIsRecord = latest > 0 && latest >= maxOther;

    return { points, deltaPct, latestIsRecord };
}

// ============================================================================
// PR DETECTION (for the share-your-PR moment on the workout-complete screen)
// ============================================================================

/**
 * Returns the single biggest personal record set TODAY — an exercise whose top
 * weight today beats its previous all-time best. Weight is returned in KG (the
 * unit weight_used is stored in); convert with toUserUnit for display. Returns
 * null when no prior history exists for today's exercises (so a brand-new lift
 * isn't falsely celebrated as a PR).
 */
export async function getTodaysTopPR(
    userId: string
): Promise<{ exerciseName: string; weightKg: number } | null> {
    try {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const iso = startOfToday.toISOString();

        const { data: todayRows } = await supabase
            .from('exercise_performance')
            .select('exercise_name, weight_used')
            .eq('user_id', userId)
            .gte('workout_date', iso);
        if (!todayRows || todayRows.length === 0) return null;

        const todayMax = new Map<string, number>();
        for (const r of todayRows) {
            const w = r.weight_used ?? 0;
            if (w <= 0) continue;
            todayMax.set(r.exercise_name, Math.max(todayMax.get(r.exercise_name) ?? 0, w));
        }
        const names = [...todayMax.keys()];
        if (names.length === 0) return null;

        const { data: priorRows } = await supabase
            .from('exercise_performance')
            .select('exercise_name, weight_used')
            .eq('user_id', userId)
            .lt('workout_date', iso)
            .in('exercise_name', names);

        const priorMax = new Map<string, number>();
        for (const r of priorRows ?? []) {
            const w = r.weight_used ?? 0;
            priorMax.set(r.exercise_name, Math.max(priorMax.get(r.exercise_name) ?? 0, w));
        }

        let best: { exerciseName: string; weightKg: number } | null = null;
        for (const [name, top] of todayMax) {
            const prev = priorMax.get(name);
            if (prev != null && top > prev) {
                if (!best || top > best.weightKg) best = { exerciseName: name, weightKg: top };
            }
        }
        return best;
    } catch {
        return null;
    }
}
