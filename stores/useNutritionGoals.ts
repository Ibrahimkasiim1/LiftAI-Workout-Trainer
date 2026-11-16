import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { computeNutritionGoals, type NutritionGoals } from '../utils/nutritionGoals';
import { getUserProfile } from '../utils/userProfile';
import { supabase } from '../utils/supabase';

// Shared source of truth for daily targets. Both the in-app editor (here) and
// the AI coach (backend `set_daily_macro_goals`) read/write this single row, so
// a calorie change made in chat shows up in the nutrition tab and vice versa.
// `nutrition_goals` may not be in the generated DB types yet, so we access it
// through a loosely-typed handle.
const nutritionGoalsTable = () =>
  (supabase as unknown as {
    from: (t: string) => any;
  }).from('nutrition_goals');

type Goals = {
  calorieGoal: number;
  proteinGoal: number;
  carbsGoal: number;
  fatsGoal: number;
};

type NutritionGoalsStore = Goals & {
  // Whose goals are currently loaded into the store (guards redundant fetches).
  loadedForUser: string | null;
  // True once the user has manually edited their targets — we then stop
  // auto-recomputing from the profile and respect their override.
  isCustom: boolean;
  /**
   * Hydrate goals for a user. If they've saved a custom override we use that;
   * otherwise we compute personalized targets from their onboarding profile.
   * Idempotent per user unless `force` is set.
   */
  loadGoalsForUser: (userId: string, force?: boolean) => Promise<void>;
  /** Persist a manual override and apply it immediately. */
  saveCustomGoals: (userId: string, goals: Goals) => Promise<void>;
  /** Drop the override and fall back to profile-derived recommendations. */
  resetToRecommended: (userId: string) => Promise<void>;
  // Low-level setter kept for back-compat with existing callers.
  setGoals: (goals: Partial<Goals>) => void;
};

const overrideKey = (userId: string) => `@nutrition_goals_override:${userId}`;

// Same fallbacks as before — used only before a profile has loaded.
const FALLBACK: Goals = {
  calorieGoal: 2200,
  proteinGoal: 160,
  carbsGoal: 240,
  fatsGoal: 70,
};

export const useNutritionGoals = create<NutritionGoalsStore>((set, get) => ({
  ...FALLBACK,
  loadedForUser: null,
  isCustom: false,

  loadGoalsForUser: async (userId, force = false) => {
    if (!userId) return;
    if (!force && get().loadedForUser === userId) return;
    // Claim the load up-front so concurrent callers (Home + Nutrition) don't
    // both fetch the profile.
    set({ loadedForUser: userId });

    const applyCache = async (): Promise<boolean> => {
      const raw = await AsyncStorage.getItem(overrideKey(userId));
      if (!raw || get().loadedForUser !== userId) return false;
      const saved = JSON.parse(raw) as Partial<Goals>;
      set({
        calorieGoal: saved.calorieGoal ?? FALLBACK.calorieGoal,
        proteinGoal: saved.proteinGoal ?? FALLBACK.proteinGoal,
        carbsGoal: saved.carbsGoal ?? FALLBACK.carbsGoal,
        fatsGoal: saved.fatsGoal ?? FALLBACK.fatsGoal,
        isCustom: true,
      });
      return true;
    };

    try {
      // 1. Source of truth: the shared nutrition_goals row.
      const { data: row, error } = await nutritionGoalsTable()
        .select('calories, protein, carbs, fats')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        // Network/DB hiccup — fall back to the offline cache so we still show
        // the user's real targets instead of resetting them.
        await applyCache();
        return;
      }

      if (row && get().loadedForUser === userId) {
        const goals: Goals = {
          calorieGoal: row.calories ?? FALLBACK.calorieGoal,
          proteinGoal: row.protein ?? FALLBACK.proteinGoal,
          carbsGoal: row.carbs ?? FALLBACK.carbsGoal,
          fatsGoal: row.fats ?? FALLBACK.fatsGoal,
        };
        set({ ...goals, isCustom: true });
        // Mirror to the offline cache for cold starts without network.
        void AsyncStorage.setItem(overrideKey(userId), JSON.stringify(goals)).catch(() => {});
        return;
      }

      // 2. No saved target → personalized recommendation from the profile.
      const { profile } = await getUserProfile(userId);
      if (!profile) return;
      const computed: NutritionGoals = computeNutritionGoals(profile);
      // Only apply if this user is still the active load (avoid clobbering a
      // newer login that arrived while we were fetching).
      if (get().loadedForUser !== userId) return;
      set({ ...computed, isCustom: false });
    } catch (err) {
      console.warn('loadGoalsForUser failed (using fallbacks):', err);
    }
  },

  saveCustomGoals: async (userId, goals) => {
    set({ ...goals, isCustom: true, loadedForUser: userId });
    if (!userId) return;
    // Offline cache first so the value survives a restart even if the write fails.
    try {
      await AsyncStorage.setItem(overrideKey(userId), JSON.stringify(goals));
    } catch (err) {
      console.warn('saveCustomGoals cache failed:', err);
    }
    // Persist to the shared source of truth so the AI coach (and other devices)
    // see the same targets.
    try {
      const { error } = await nutritionGoalsTable().upsert(
        {
          user_id: userId,
          calories: Math.round(goals.calorieGoal),
          protein: Math.round(goals.proteinGoal),
          carbs: Math.round(goals.carbsGoal),
          fats: Math.round(goals.fatsGoal),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );
      if (error) throw error;
    } catch (err) {
      console.warn('saveCustomGoals DB persist failed:', err);
    }
  },

  resetToRecommended: async (userId) => {
    try {
      if (userId) {
        await AsyncStorage.removeItem(overrideKey(userId));
        const { error } = await nutritionGoalsTable().delete().eq('user_id', userId);
        if (error) throw error;
      }
    } catch (err) {
      console.warn('resetToRecommended clear failed:', err);
    }
    await get().loadGoalsForUser(userId, true);
  },

  setGoals: (goals) => set((prev) => ({ ...prev, ...goals })),
}));
