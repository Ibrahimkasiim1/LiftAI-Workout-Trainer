import { Database } from '../../types/supabase';
import { supabase } from '../../utils/supabase';

type UserProfileInsert = Database['public']['Tables']['user_profiles']['Insert'];
type UserProfileUpdate = Database['public']['Tables']['user_profiles']['Update'];

export const UserService = {
    /**
     * Get the full profile for the current user
     */
    async getProfile(userId: string) {
        const { data, error } = await supabase
            .from('user_profiles')
            .select('*')
            .eq('id', userId)
            .single();

        if (error && error.code !== 'PGRST116') throw error; // Ignore "not found" error
        return data;
    },

    /**
     *Save or Update the user profile (Used in Onboarding)
     */
    async saveProfile(profileData: UserProfileInsert) {
        const { data, error } = await supabase
            .from('user_profiles')
            .upsert(profileData)
            .select()
            .single();

        if (error) throw error;
        return data;
    },

    /**
     * Update specific fields in user profile
     */
    async updateProfile(userId: string, updates: UserProfileUpdate) {
        const { data, error } = await supabase
            .from('user_profiles')
            .update(updates)
            .eq('id', userId)
            .select()
            .single();

        if (error) throw error;
        return data;
    },

    /**
     * Mark onboarding as complete
     */
    async completeOnboarding(userId: string) {
        const { error } = await supabase
            .from('user_profiles')
            .update({ onboarding_completed: true })
            .eq('id', userId);

        if (error) throw error;
    },

    /**
     * Check if user has completed onboarding
     */
    async hasCompletedOnboarding(userId: string): Promise<boolean> {
        const { data } = await supabase
            .from('user_profiles')
            .select('onboarding_completed')
            .eq('id', userId)
            .single();

        return data?.onboarding_completed ?? false;
    },

    /**
     * Check if user has completed onboarding questions
     */
    async hasCompletedOnboardingQuestions(userId: string): Promise<boolean> {
        const { data } = await supabase
            .from('user_profiles')
            .select('onboarding_questions_completed')
            .eq('id', userId)
            .single();

        return data?.onboarding_questions_completed ?? false;
    },

    /**
     * Check if notification permission has been requested
     */
    async hasRequestedNotificationPermission(userId: string): Promise<boolean> {
        const { data } = await supabase
            .from('user_profiles')
            .select('notification_permission_requested')
            .eq('id', userId)
            .single();

        return data?.notification_permission_requested ?? false;
    },

    /**
     * Delete user account and all associated data (via `delete_user` RPC).
     * Caller must ensure the current session is `userId` (RPC uses `auth.uid()`).
     */
    async deleteAccount(userId: string) {
        const {
            data: { user },
            error: userError,
        } = await supabase.auth.getUser();
        if (userError || !user || user.id !== userId) {
            throw userError ?? new Error('Session does not match this account.');
        }

        const { error } = await supabase.rpc('delete_user');
        if (error) throw error;

        await supabase.auth.signOut();
    }
};
