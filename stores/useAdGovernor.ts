import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const WARMUP_MS = 90 * 1000;
const COOLDOWN_MS = 3 * 60 * 1000;

/**
 * Hard ceiling on interstitials inside a single workout session. The 3-min
 * cooldown alone still allows ~10 ads across a 45-minute workout; effort
 * sessions get a small fixed budget instead.
 */
const WORKOUT_SESSION_AD_CAP = 2;

/** Set once the user has completed their first workout (or a DB check proves
 *  they already had — existing installs must not lose ads forever). */
const ACTIVATION_KEY = '@first_workout_completed_v1';
/** Older signal written on the first logged set — counts as activated too. */
const LEGACY_FIRST_SET_KEY = '@first_set_logged_v1';

interface AdGovernorState {
  sessionStartedAt: number;
  lastInterstitialAt: number | null;
  /**
   * False until the user's first workout is done. EVERY interstitial surface
   * (periodic, rest-window, dwell) consults canShowInterstitial, so this one
   * flag protects the whole activation window. Defaults to false — before
   * hydration completes we'd rather suppress an ad than show one to a
   * brand-new user.
   */
  activationDone: boolean;
  workoutSessionActive: boolean;
  workoutSessionAdsShown: number;
  canShowInterstitial: () => boolean;
  recordInterstitialShown: () => void;
  /** Resolve activationDone from AsyncStorage, falling back to a one-row DB
   *  check for installs that predate the local flags. Safe to call repeatedly. */
  hydrateActivation: () => Promise<void>;
  /** Call when a workout completes — flips the gate and persists it. */
  markActivationComplete: () => void;
  /** Workout player mount/unmount — scopes the per-workout ad cap. */
  beginWorkoutAdSession: () => void;
  endWorkoutAdSession: () => void;
  resetSession: () => void;
}

let hydrateStarted = false;

export const useAdGovernor = create<AdGovernorState>((set, get) => ({
  sessionStartedAt: Date.now(),
  lastInterstitialAt: null,
  activationDone: false,
  workoutSessionActive: false,
  workoutSessionAdsShown: 0,

  canShowInterstitial: () => {
    const {
      sessionStartedAt,
      lastInterstitialAt,
      activationDone,
      workoutSessionActive,
      workoutSessionAdsShown,
    } = get();
    if (!activationDone) return false;
    if (workoutSessionActive && workoutSessionAdsShown >= WORKOUT_SESSION_AD_CAP) return false;
    const now = Date.now();
    if (now - sessionStartedAt < WARMUP_MS) return false;
    if (lastInterstitialAt != null && now - lastInterstitialAt < COOLDOWN_MS) return false;
    return true;
  },

  recordInterstitialShown: () => {
    set((state) => ({
      lastInterstitialAt: Date.now(),
      workoutSessionAdsShown: state.workoutSessionActive
        ? state.workoutSessionAdsShown + 1
        : state.workoutSessionAdsShown,
    }));
  },

  hydrateActivation: async () => {
    if (get().activationDone || hydrateStarted) return;
    hydrateStarted = true;
    try {
      const [done, firstSet] = await Promise.all([
        AsyncStorage.getItem(ACTIVATION_KEY),
        AsyncStorage.getItem(LEGACY_FIRST_SET_KEY),
      ]);
      if (done === '1' || firstSet === '1') {
        set({ activationDone: true });
        return;
      }
      // Installs from before these flags existed: one cheap indexed lookup.
      const { getSession, supabase } = await import('../utils/supabase');
      const session = await getSession();
      if (!session?.user?.id) {
        hydrateStarted = false; // signed out — retry after login
        return;
      }
      const { data, error } = await supabase
        .from('workout_completions')
        .select('id')
        .eq('user_id', session.user.id)
        .eq('workout_type', 'workout')
        .limit(1)
        .maybeSingle();
      if (error) {
        hydrateStarted = false; // transient — allow a retry on next foreground
        return;
      }
      if (data?.id) {
        await AsyncStorage.setItem(ACTIVATION_KEY, '1');
        set({ activationDone: true });
      }
      // No completions: genuinely pre-activation. Leave the gate closed;
      // markActivationComplete flips it the moment the first workout ends.
    } catch {
      hydrateStarted = false;
    }
  },

  markActivationComplete: () => {
    set({ activationDone: true });
    void AsyncStorage.setItem(ACTIVATION_KEY, '1').catch(() => {});
  },

  beginWorkoutAdSession: () => {
    set({ workoutSessionActive: true, workoutSessionAdsShown: 0 });
  },

  endWorkoutAdSession: () => {
    set({ workoutSessionActive: false, workoutSessionAdsShown: 0 });
  },

  resetSession: () => {
    set({ sessionStartedAt: Date.now(), lastInterstitialAt: null, workoutSessionAdsShown: 0 });
  },
}));
