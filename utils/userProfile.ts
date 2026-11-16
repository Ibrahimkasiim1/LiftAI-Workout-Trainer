// utils/userProfile.ts
//
// IMPORTANT: The database now auto-creates a bare profile row via trigger
// when a user registers (handle_new_user trigger on auth.users).
// This means saveUserProfile MUST use upsert (not insert) to UPDATE
// the existing row rather than trying to create a new one.

import type { Database } from '../types/supabase';
import { supabase } from './supabase';

export type UserProfile = Database['public']['Tables']['user_profiles']['Row'];

type UserProfileInsert = Database['public']['Tables']['user_profiles']['Insert'];
export type UserProfileUpdate = Database['public']['Tables']['user_profiles']['Update'];

interface ProfileData {
    name: string;
    birthday: string;
    gender: string;
    height_cm: number;
    weight_kg: number;
    goal: string;
    goal_weight_kg: number;
    pace: string;
    fitness_level: string;
    workout_days_per_week: number;
    selected_workout_days: string[];
    workout_split_type: string;
    workout_duration_minutes: number;
    location: string;
    available_equipment: string[];
    injuries?: string;
    [key: string]: any;
}

/**
 * Persist a PARTIAL set of onboarding answers for an authenticated user.
 *
 * Called at section boundaries during onboarding so progress survives an app
 * delete/reinstall (AsyncStorage does not). Only whitelisted, pre-validated
 * fields are written — completion flags are untouched, so the funnel guard
 * still routes the user back into onboarding to finish.
 */
export async function savePartialOnboardingProfile(
    userId: string,
    fields: Partial<Omit<ProfileData, 'selected_workout_days'>> & {
        // Onboarding holds days as a {day: boolean} map; the profile stores string[].
        selected_workout_days?: string[] | { [day: string]: boolean };
    }
): Promise<{ error: any }> {
    try {
        const update: Record<string, any> = {};

        if (fields.name?.trim()) update.name = fields.name.trim();
        if (fields.birthday) update.birthday = fields.birthday;
        if (['Male', 'Female', 'Other'].includes(fields.gender ?? '')) update.gender = fields.gender;
        if (['gain', 'build_muscle', 'maintain', 'lose'].includes(fields.goal ?? '')) update.goal = fields.goal;
        if (['slow', 'medium', 'fast'].includes(fields.pace ?? '')) update.pace = fields.pace;
        if (['beginner', 'intermediate', 'expert'].includes(fields.fitness_level ?? '')) {
            update.fitness_level = fields.fitness_level;
        }
        if (typeof fields.height_cm === 'number' && fields.height_cm > 0) update.height_cm = fields.height_cm;
        if (typeof fields.weight_kg === 'number' && fields.weight_kg > 0 && fields.weight_kg <= 1000) {
            update.weight_kg = fields.weight_kg;
        }
        if (
            typeof fields.goal_weight_kg === 'number' &&
            fields.goal_weight_kg > 0 &&
            fields.goal_weight_kg <= 1000
        ) {
            update.goal_weight_kg = fields.goal_weight_kg;
        }
        const days = Array.isArray(fields.selected_workout_days)
            ? fields.selected_workout_days
            : Object.keys(fields.selected_workout_days || {});
        if (days.length >= 1 && days.length <= 7) {
            update.selected_workout_days = days;
            update.workout_days_per_week = days.length;
        }

        if (Object.keys(update).length === 0) return { error: null };

        const { error } = await supabase
            .from('user_profiles')
            .update(update as UserProfileUpdate)
            .eq('id', userId);
        if (error) console.warn('savePartialOnboardingProfile failed:', error.message);
        return { error };
    } catch (err) {
        console.warn('savePartialOnboardingProfile exception:', err);
        return { error: err };
    }
}

export async function saveUserProfile(
    userId: string,
    data: ProfileData
): Promise<{ error: any }> {
    try {
        // Clean and validate data before saving
        const cleanData: Record<string, any> = {
            id: userId,
            name: (data.name || '').trim() || 'User',
            birthday: data.birthday || '2000-01-01',
            gender: data.gender || 'Other',
            height_cm: data.height_cm || 170,
            weight_kg: data.weight_kg || 70,
            goal: data.goal || 'maintain',
            goal_weight_kg: data.goal_weight_kg || data.weight_kg || 70,
            pace: data.pace || 'medium',
            fitness_level: data.fitness_level || 'intermediate',
            workout_days_per_week: data.workout_days_per_week || 3,
            selected_workout_days: Array.isArray(data.selected_workout_days)
                ? data.selected_workout_days
                : Object.keys(data.selected_workout_days || {}),
            workout_split_type: data.workout_split_type || 'full_body',
            workout_duration_minutes: data.workout_duration_minutes || 60,
            location: data.location || 'gym',
            available_equipment: data.available_equipment || [],
            injuries: data.injuries || '',
            onboarding_questions_completed: true,
            // NEVER write onboarding_completed here. This upsert runs whenever
            // the quiz is completed — including when an already-onboarded user
            // is routed back through it — and hard-coding `false` demoted
            // fully-onboarded (even paying) users into a permanent funnel loop.
            // Completion is owned solely by completeOnboarding() at plan
            // confirmation; new users start false via the column default.
        };

        // Validate CHECK constraint values
        const validGenders = ['Male', 'Female', 'Other'];
        if (!validGenders.includes(cleanData.gender)) cleanData.gender = 'Other';

        const validGoals = ['gain', 'build_muscle', 'maintain', 'lose'];
        if (!validGoals.includes(cleanData.goal)) cleanData.goal = 'maintain';

        const validPaces = ['slow', 'medium', 'fast'];
        if (!validPaces.includes(cleanData.pace)) cleanData.pace = 'medium';

        const validFitness = ['beginner', 'intermediate', 'expert'];
        if (!validFitness.includes(cleanData.fitness_level)) cleanData.fitness_level = 'intermediate';

        const validSplits = ['full_body', 'upper_lower', 'ppl', 'bro_split', 'hybrid', 'custom'];
        if (!validSplits.includes(cleanData.workout_split_type)) cleanData.workout_split_type = 'full_body';

        const validLocations = ['home', 'gym', 'hybrid'];
        if (!validLocations.includes(cleanData.location)) cleanData.location = 'gym';

        // Ensure numeric constraints
        if (cleanData.height_cm <= 0) cleanData.height_cm = 170;
        if (cleanData.weight_kg <= 0 || cleanData.weight_kg > 1000) cleanData.weight_kg = 70;
        if (cleanData.goal_weight_kg <= 0 || cleanData.goal_weight_kg > 1000) cleanData.goal_weight_kg = 70;
        if (cleanData.workout_days_per_week < 1 || cleanData.workout_days_per_week > 7) cleanData.workout_days_per_week = 3;
        if (cleanData.workout_duration_minutes <= 0) cleanData.workout_duration_minutes = 60;

        // UPSERT: Update existing row (created by trigger) or insert if somehow missing
        const { error } = await supabase
            .from('user_profiles')
            .upsert(cleanData as UserProfileInsert, { onConflict: 'id' });

        if (error) {
            console.error('saveUserProfile upsert error:', error);
            return { error };
        }

        // Seed a body weight log so the Progress/Home trend has a starting datapoint.
        // Only inserted when the user has no prior body_weight_logs entry; otherwise
        // it would clutter the time series each time they edit their profile.
        await seedInitialBodyWeightLog(userId, cleanData.weight_kg);

        console.log('Profile saved successfully for user:', userId);
        return { error: null };
    } catch (err) {
        console.error('saveUserProfile exception:', err);
        return { error: err };
    }
}

/**
 * Insert the user's onboarding weight into body_weight_logs if (and only if)
 * they have no log yet. This gives the trend chart a starting point without
 * polluting the series on subsequent profile edits.
 */
async function seedInitialBodyWeightLog(userId: string, weightKg: number): Promise<void> {
    try {
        const { count } = await (supabase as any)
            .from('body_weight_logs')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId);
        if ((count ?? 0) > 0) return;
        await (supabase as any).from('body_weight_logs').insert({
            user_id: userId,
            weight_kg: weightKg,
            note: 'onboarding',
        });
    } catch (err) {
        console.warn('seedInitialBodyWeightLog failed (non-fatal):', err);
    }
}

/**
 * Log a new body-weight datapoint. Inserts into the `body_weight_logs` time
 * series AND updates `user_profiles.weight_kg` so any UI reading the snapshot
 * (e.g. Progress tab) stays current. Weight is always stored in kg.
 */
export async function logBodyWeight(
    userId: string,
    weightKg: number,
    note?: string,
): Promise<{ error: any }> {
    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 1000) {
        return { error: 'Invalid weight' };
    }
    try {
        const { error: insertError } = await (supabase as any)
            .from('body_weight_logs')
            .insert({ user_id: userId, weight_kg: weightKg, note: note ?? null });
        if (insertError) return { error: insertError };
        await supabase
            .from('user_profiles')
            .update({ weight_kg: weightKg })
            .eq('id', userId);
        return { error: null };
    } catch (err) {
        return { error: err };
    }
}

/**
 * Patch fields on the signed-in user's profile row.
 */
export async function updateUserProfile(
    userId: string,
    updates: Partial<UserProfileUpdate>
): Promise<{ error: any }> {
    try {
        const { error } = await supabase.from('user_profiles').update(updates).eq('id', userId);
        return { error };
    } catch (err) {
        console.error('updateUserProfile exception:', err);
        return { error: err };
    }
}

/**
 * Permanently deletes the signed-in user via Supabase `delete_user` RPC
 * (SECURITY DEFINER: removes `auth.users` row; FK cascades remove app data).
 * Must be called while the target user is authenticated (`auth.uid()`).
 */
export async function deleteUserAccount(userId: string): Promise<{ error: string | null }> {
    try {
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser();
        if (userError || !user) {
            return { error: userError?.message ?? 'Not signed in.' };
        }
        if (user.id !== userId) {
            return { error: 'Session does not match this account.' };
        }

        const { error } = await supabase.rpc('delete_user');
        if (error) {
            return { error: error.message };
        }

        await supabase.auth.signOut();
        return { error: null };
    } catch (err) {
        return { error: String(err) };
    }
}

export async function getUserProfile(userId: string): Promise<{
    profile: UserProfile | null;
    error: any;
}> {
    try {
        const { data, error } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('id', userId)
            .single();

        return { profile: data, error };
    } catch (err) {
        console.error('getUserProfile exception:', err);
        return { profile: null, error: err };
    }
}

/**
 * Check if user has completed onboarding questions
 */
export async function hasCompletedOnboardingQuestions(userId: string): Promise<boolean> {
    const { data } = await supabase
        .from('user_profiles')
        .select('onboarding_questions_completed')
        .eq('id', userId)
        .single();

    return data?.onboarding_questions_completed ?? false;
}

/**
 * Check if notification permission has been requested
 */
export async function hasRequestedNotificationPermission(userId: string): Promise<boolean> {
    const { data } = await supabase
        .from('user_profiles')
        .select('notification_permission_requested')
        .eq('id', userId)
        .single();

    return data?.notification_permission_requested ?? false;
}

/**
 * Mark onboarding as complete
 */
export async function completeOnboarding(userId: string): Promise<{ error: any }> {
    try {
        const { error } = await supabase
            .from('user_profiles')
            .update({
                onboarding_completed: true,
                onboarding_questions_completed: true,
            })
            .eq('id', userId);

        if (error) {
            console.error('completeOnboarding error:', error);
            return { error };
        }
        return { error: null };
    } catch (err) {
        console.error('completeOnboarding exception:', err);
        return { error: err };
    }
}
