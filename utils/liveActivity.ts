// Bridge to the native iOS Live Activity (workout Dynamic Island + lock-screen widget).
// The activity spans the entire workout: work phase shows the current exercise and
// an elapsed timer, rest phase shows the countdown. All methods are no-ops on
// Android / non-iOS-16.2+ devices and never throw.

import { NativeModules, NativeEventEmitter, Platform, type EmitterSubscription } from 'react-native';

type StartParams = {
  exerciseName: string;
  workoutName?: string;
  setNumber: number;
  totalSets: number;
  // 1-based position of the exercise within the workout ("Exercise 2 of 6").
  exerciseIndex?: number;
  totalExercises?: number;
  // True while the rest countdown runs; false/omitted while the user is lifting.
  isResting?: boolean;
  // Rest countdown end. Only used when isResting is true.
  endTimeMs?: number;
  // Workout start timestamp; drives the elapsed timer shown in the work phase.
  workoutStartMs?: number;
  // Public Supabase URL of the exercise GIF. The native side downloads the
  // first frame to the shared App Group container so the widget can render it.
  gifUrl?: string;
};

type UpdateParams = Partial<StartParams>;

type LiftLiveActivityNativeModule = {
  areActivitiesEnabled(): Promise<boolean>;
  startActivity(params: StartParams): Promise<string>;
  updateActivity(params: UpdateParams): Promise<boolean>;
  endActivity(): Promise<boolean>;
};

const Native = (NativeModules as { LiftLiveActivityModule?: LiftLiveActivityNativeModule })
  .LiftLiveActivityModule;

const emitter =
  Platform.OS === 'ios' && Native ? new NativeEventEmitter(Native as unknown as never) : null;

/**
 * Pro entitlement gate. The Dynamic Island / Live Activity is a paid feature,
 * so we suppress `start` calls when the user is on the free tier. The flag is
 * kept at module scope (rather than threaded through every caller) and synced
 * by SubscriptionContext whenever the user's entitlement state changes.
 *
 * Defaults to `false` — better to no-op the widget for the first frame than
 * to flash it for a free user before the entitlement loads.
 */
let isEntitled = false;

export function setLiveActivityEntitlement(entitled: boolean): void {
  isEntitled = entitled;
}

export const liveActivity = {
  isSupported(): boolean {
    return Platform.OS === 'ios' && !!Native;
  },

  async areActivitiesEnabled(): Promise<boolean> {
    if (!Native) return false;
    try {
      return await Native.areActivitiesEnabled();
    } catch {
      return false;
    }
  },

  /**
   * Start (or re-sync) the workout Live Activity. Idempotent: when an activity
   * is already running the native side updates it in place instead of ending
   * and re-requesting, so the Dynamic Island never flickers on phase changes.
   */
  async start(params: StartParams): Promise<void> {
    if (!Native) return;
    if (!isEntitled) {
      // Pro-gated: free users get the in-app rest timer but not the
      // Dynamic Island / lock-screen widget. Silent no-op by design — the
      // upgrade prompt lives in the rest timer UI, not here.
      return;
    }
    try {
      await Native.startActivity({
        workoutName: 'LiftAI Workout',
        ...params,
      });
    } catch (err) {
      console.warn('[liveActivity] start failed', err);
    }
  },

  async update(params: UpdateParams): Promise<void> {
    if (!Native) return;
    try {
      await Native.updateActivity(params);
    } catch (err) {
      console.warn('[liveActivity] update failed', err);
    }
  },

  async end(): Promise<void> {
    if (!Native) return;
    try {
      await Native.endActivity();
    } catch (err) {
      console.warn('[liveActivity] end failed', err);
    }
  },

  /**
   * Subscribe to Skip Rest taps from the widget (Dynamic Island / lock screen button).
   * Returns an unsubscribe function. No-op when native module is unavailable.
   */
  onSkipRequested(handler: () => void): () => void {
    if (!emitter) return () => {};
    const sub: EmitterSubscription = emitter.addListener('RestTimerSkipRequested', handler);
    return () => sub.remove();
  },
};
