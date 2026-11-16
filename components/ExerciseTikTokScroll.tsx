/**
 * ExerciseTikTokScroll Component
 * 
 * A full-screen vertical scrolling workout interface that mimics TikTok's vertical scroll behavior
 * for displaying and tracking exercise workouts. This component provides an immersive workout
 * experience with real-time progress tracking, rest timers, and performance logging.
 * 
 * MAIN FUNCTIONALITY:
 * - Displays exercises in a vertical scrollable format (one exercise per screen)
 * - Tracks workout progress with set completion and rest timers
 * - Integrates with RapidAPI ExerciseDB for exercise data and images
 * - Logs workout performance to Supabase database
 * - Provides haptic feedback and notifications for workout guidance
 * - Prevents users from skipping exercises without completing all sets
 * 
 * ROUTES/NAVIGATION:
 * - Uses React Navigation for back navigation
 * - Integrates with app's tab navigation system
 * - Can trigger completion callbacks for parent components
 * 
 * API INTEGRATIONS:
 * - RapidAPI ExerciseDB: Fetches exercise details and images
 * - Supabase: Stores workout performance data and user progress
 * - Expo Notifications: Sends rest timer notifications
 * 
 * @fileoverview TikTok-style vertical scrolling workout interface with progress tracking
 */

import { Ionicons } from '@expo/vector-icons';
import BottomSheet, { BottomSheetModal, BottomSheetModalProvider, BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as Notifications from 'expo-notifications';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Dimensions,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import Animated, {
  Easing,
  Extrapolate,
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Asset } from 'expo-asset';
import * as Crypto from 'expo-crypto';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { backendClient, isQuotaExceededError, QuotaExceededError } from '../src/api/backendClient';
import { posthog } from '../src/config/posthog';
import QuotaLimitSheet from './QuotaLimitSheet';
import { toast } from './ui/Toast';
import { confirmSheet } from './ui/ConfirmSheet';
import { ExercisePerformanceLog, getExerciseHistory, logWorkoutCompletion, saveSetPerformance, updateSetPerformance } from '../src/services/ProgressService';
import { ExerciseCard } from '../types/workoutPayload';
import { getLocalDateString } from '../utils/date';
import { getExerciseGifUrl } from '../utils/exerciseGifs';
import { formatExerciseName } from '../utils/exerciseName';
import { performGuardedWorkoutExit } from '../utils/workoutExit';
import { getActiveWorkoutSession, saveActiveWorkoutSession } from '../utils/storage';
import { getSession, supabase } from '../utils/supabase';
import { getWeightUnit, toKg, toUserUnit } from '../utils/weightConverter';
import { useAdGovernor } from '@/stores/useAdGovernor';
import { useWorkoutStore } from '@/stores/useWorkoutStore';
import { liveActivity } from '../utils/liveActivity';
import { useUserQuota } from '@/hooks/useUserQuota';
import { useProGate } from '../hooks/useProGate';
import { BannerAdSize } from 'react-native-google-mobile-ads';
import AdBanner from './AdBanner';
import useInterstitialAd from './FullScreenAd';
import FirstVisitHint from './FirstVisitHint';
import InlineSetLogger from './InlineSetLogger';
import WorkoutTimerPill from './WorkoutTimerPill';
import EditSetsSheet from './EditSetsSheet';
import StatShareButton from './StatShareButton';
// VOICE COACH STASHED (not shipping this version): the voiceMode service +
// VoiceCaptions UI are removed from this screen and the source files are
// renamed to *.stashed. Restore those files + the imports here to re-enable.
import { buildCoachNote, minStep, recommendSets, type CoachExerciseNote, type SetRecommendation } from '../src/services/progressiveOverload';
import { buildSetReaction } from '../src/services/coachReactions';
import LiabilityConsentSheet, { CONSENT_STORAGE_KEY, CONSENT_VERSION } from './LiabilityConsentSheet';
import CoachMessageCard from './CoachMessageCard';
import CoachQuestionCard from './CoachQuestionCard';
import CoachTargetStrip from './CoachTargetStrip';

// Notification logo image
const NOTIFICATION_LOGO_ASSET = require('../assets/images/Lift.jpg');
let NOTIFICATION_LOGO_URI: string | null = null;

// Initialize notification logo URI
const initializeNotificationLogo = async (): Promise<string | null> => {
  if (NOTIFICATION_LOGO_URI) return NOTIFICATION_LOGO_URI;

  try {
    const asset = Asset.fromModule(NOTIFICATION_LOGO_ASSET);
    await asset.downloadAsync();
    NOTIFICATION_LOGO_URI = asset.localUri || asset.uri;
    return NOTIFICATION_LOGO_URI;
  } catch (error) {
    console.error('Error loading notification logo:', error);
    return null;
  }
};



const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');

/**
 * Exercise data structure from RapidAPI ExerciseDB
 * Contains all exercise metadata including instructions, equipment, and muscle targets
 */
interface Exercise {
  id: string;                    // Unique exercise identifier
  name: string;                  // Exercise display name
  bodyPart: string;              // Primary body part (e.g., "chest", "legs")
  equipment: string;             // Required equipment (e.g., "barbell", "body weight")
  target: string;                // Target muscle group
  secondaryMuscles: string[];    // Secondary muscles worked
  instructions: string[];        // Step-by-step exercise instructions
  description: string;           // Exercise description
  difficulty: string;            // Difficulty level
  category: string;              // Exercise category
}

/**
 * Exercise progress tracking state
 * Tracks current workout progress including sets completed and performance data
 */
interface ExerciseProgress {
  exerciseIndex: number;           // Current exercise index in workout
  currentSet: number;              // Current set number (1-based)
  totalSets: number;               // Total sets for current exercise
  setsCompleted: ExercisePerformanceLog[]; // Array of completed set performance data
}

interface ListModeItem {
  exercise: ExerciseCard;
  absoluteIndex: number;
  instanceKey: string;
  isLocked: boolean;
  isCurrent: boolean;
  isCompleted: boolean;
  equipmentLabel: string;
}

type SwapReason = 'equipment_taken' | 'pain_injury' | 'too_hard' | 'other';

interface ExerciseAlternative {
  id: string;
  name: string;
  target_muscle?: string | null;
  body_part?: string | null;
  equipment?: string | null;
  gif_path?: string | null;
}

/**
 * Component Props Interface
 * 
 * PURELY PRESENTATIONAL: This component receives fully structured exercise data.
 * NO data fetching, NO transformation - data comes from upstream (WorkoutScreen).
 * 
 * @param exercises - Required: Array of ExerciseCard objects from backend (THE PRIMARY DATA SOURCE)
 * @param onExerciseChange - Optional callback when user scrolls to different exercise
 * @param onComplete - Optional callback when entire workout is completed
 * @param sessionId - Optional session ID for resuming workouts
 * @param workoutType - Workout type to distinguish between different workout sources
 */
interface ExerciseTikTokScrollProps {
  /** REQUIRED: Fully structured exercise data from backend. This is the SINGLE source of truth. */
  exercises: ExerciseCard[];
  /** Optional callback when user scrolls to different exercise */
  onExerciseChange?: (exercise: Exercise, index: number) => void;
  /** Optional callback when entire workout is completed */
  onComplete?: () => void;
  /** Optional session ID for resuming workouts */
  sessionId?: string;
  /** Workout type to distinguish between different workout sources */
  workoutType?: 'main_plan' | 'extra_workout' | 'saved_workout' | 'replacement_workout';
}

/**
 * ExerciseTikTokScroll Component
 * 
 * Main component that renders a TikTok-style vertical scrolling workout interface.
 * Handles exercise display, progress tracking, rest timers, and performance logging.
 * 
 * STATE MANAGEMENT:
 * - exercises: Array of exercise data from RapidAPI
 * - loading: Loading state for exercise data fetching
 * - currentIndex: Current exercise being viewed
 * - exerciseProgress: Tracks sets, reps, and completion status
 * - restTimeRemaining: Countdown timer for rest periods
 * - notificationPermission: Permission status for rest notifications
 * 
 * REFS:
 * - flatListRef: Reference to the main scrollable list
 * - bottomSheetRef: Reference to instructions bottom sheet
 * - restBottomSheetRef: Reference to rest timer bottom sheet
 * - navigation: React Navigation hook for back navigation
 */
const ExerciseTikTokScroll: React.FC<ExerciseTikTokScrollProps> = ({
  exercises: exercisesProp,
  onExerciseChange,
  onComplete,
  sessionId,
  workoutType: workoutTypeProp,
}) => {
  const mapToDisplayExercise = useCallback((ex: ExerciseCard): Exercise => ({
    id: ex.id,
    name: ex.name,
    bodyPart: ex.body_part || 'unknown',
    equipment: ex.equipment || 'body weight',
    target: ex.target_muscle || 'unknown',
    secondaryMuscles: [],
    instructions: ex.instructions || ['Perform this exercise with proper form'],
    description: ex.name,
    difficulty: ex.difficulty || 'intermediate',
    category: 'strength',
  }), []);

  // Exercise data state - initialized from props, NOT fetched
  // Convert ExerciseCard[] to internal Exercise[] format on mount
  const [exercises, setExercises] = useState<Exercise[]>(() =>
    exercisesProp.map(mapToDisplayExercise)
  );
  // Loading is false immediately - data comes from props, no fetching needed
  const [loading, setLoading] = useState(false);
  // Absolute index in structuredExercises (not pager-local index)
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedExercise, setSelectedExercise] = useState<Exercise | null>(null);
  // Structured exercises directly from props - THE source of truth
  const [structuredExercises, setStructuredExercises] = useState<ExerciseCard[]>(exercisesProp);

  // Animation and UI refs
  const scrollY = useSharedValue(0);
  const flatListRef = useRef<Animated.FlatList<any>>(null);
  const bottomSheetRef = useRef<BottomSheet>(null);
  const restBottomSheetRef = useRef<BottomSheet>(null);
  const listModeSheetRef = useRef<BottomSheetModal>(null);
  const restScrollViewRef = useRef<any>(null);
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  // Workout progress tracking state
  const [exerciseProgress, setExerciseProgress] = useState<ExerciseProgress>({
    exerciseIndex: 0,
    currentSet: 1,
    totalSets: 3,
    setsCompleted: [],
  });

  // Rest timer state
  const [restTimeRemaining, setRestTimeRemaining] = useState(0);
  const [restEndTime, setRestEndTime] = useState<number | null>(null);
  const [ghostDataBySet, setGhostDataBySet] = useState<Record<number, { weight: number; reps: number; date: string }>>({});
  // AI-generated progressive-overload recommendations for the current exercise,
  // one entry per planned set. Drives the prefilled values in InlineSetLogger.
  const [setRecommendations, setSetRecommendations] = useState<SetRecommendation[]>([]);
  // Personalized one-liner for the current exercise (shown in CoachTargetStrip).
  const [coachNote, setCoachNote] = useState<CoachExerciseNote | null>(null);
  // In-workout coach questions. The feeling answer biases this session's
  // recommendations (tired/sore → hold weights); both answers persist to the
  // user's coach memory so the chat agent knows too.
  const [sessionFeeling, setSessionFeeling] = useState<'fresh' | 'good' | 'tired' | 'sore' | null>(null);
  const [feelingAsked, setFeelingAsked] = useState(false);
  const [difficultyAsked, setDifficultyAsked] = useState(false);
  // Latest coach reaction to a logged set (see buildSetReaction). The id keys
  // the card so each new message remounts it — an X-dismissed card reappears
  // when the next reaction lands.
  const [coachReaction, setCoachReaction] = useState<{ id: number; text: string; isSuggestion: boolean } | null>(null);
  const coachReactionIdRef = useRef(0);
  // Exercise index whose target strip the user X'd — hidden until they move
  // on to a different exercise (comparison by index self-resets).
  const [stripDismissedForExercise, setStripDismissedForExercise] = useState<number | null>(null);
  // Anchor for the top pill's "time on this exercise" clock — resets whenever
  // the active exercise changes. The per-second ticking stays inside the pill.
  const [exerciseStartedAt, setExerciseStartedAt] = useState<number>(() => Date.now());
  // Set by loadSavedProgress when it restores a persisted anchor: the index
  // change it triggers must NOT re-reset the clock (that's the "timer resets
  // every time I come back into my workout" bug).
  const skipNextExerciseStartResetRef = useRef(false);
  useEffect(() => {
    if (skipNextExerciseStartResetRef.current) {
      skipNextExerciseStartResetRef.current = false;
      return;
    }
    setExerciseStartedAt(Date.now());
  }, [exerciseProgress.exerciseIndex]);

  // First-ever-workout liability consent. null = still loading (render
  // nothing gated on it), false = must agree before training, true = done.
  // The versioned record lives in AsyncStorage; acceptance is also stamped
  // to PostHog and (best-effort) user_profiles.liability_accepted_at.
  const [liabilityAccepted, setLiabilityAccepted] = useState<boolean | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(CONSENT_STORAGE_KEY);
        const parsed = raw ? (JSON.parse(raw) as { version?: number }) : null;
        setLiabilityAccepted((parsed?.version ?? 0) >= CONSENT_VERSION);
      } catch {
        // Can't read the record — fail SAFE by asking again (an extra ask
        // is harmless; a skipped consent is not).
        setLiabilityAccepted(false);
      }
    })();
  }, []);

  // Leaving the player is not a plain goBack(): the player can be the ONLY
  // screen in its stack (the onboarding first-workout screen enters via
  // router.replace), and the root entry BELOW it can be a pre-auth funnel
  // group — goBack() then dumps a signed-in user onto the logged-out welcome
  // screen.
  // Decide from the actual stack shapes; when in doubt, replace to home.
  // The walk + decision live once in utils/workoutExit.ts — shared with the
  // host screen's completion and error-boundary exits.
  const exitToPreviousOrHome = useCallback(() => {
    performGuardedWorkoutExit(navigation);
  }, [navigation]);

  const handleConsentAccept = useCallback(async () => {
    const acceptedAt = new Date().toISOString();
    setLiabilityAccepted(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      await AsyncStorage.setItem(
        CONSENT_STORAGE_KEY,
        JSON.stringify({ version: CONSENT_VERSION, acceptedAt })
      );
    } catch { /* local write failed — the server/analytics stamps below still record it */ }
    posthog.capture('liability_consent_accepted', { version: CONSENT_VERSION });
    // Durable server copy — best-effort: the column may not exist until the
    // liability_accepted_at migration is applied, and consent must not block
    // on the network.
    try {
      const session = await getSession();
      if (session) {
        await (supabase.from('user_profiles') as any)
          .update({ liability_accepted_at: acceptedAt })
          .eq('id', session.user.id);
      }
    } catch { /* offline / column missing — local + PostHog records remain */ }
  }, []);

  const handleConsentDecline = useCallback(() => {
    posthog.capture('liability_consent_declined');
    exitToPreviousOrHome();
  }, [exitToPreviousOrHome]);

  // The check-in questions are once-per-day, not once-per-mount: leaving and
  // re-entering a workout (or a second session the same day) must not re-ask.
  // Stored answers also re-apply the feeling bias to resumed sessions.
  useEffect(() => {
    void (async () => {
      try {
        const today = getLocalDateString();
        const [feelingRaw, difficultyRaw] = await Promise.all([
          AsyncStorage.getItem('@coach_feeling_checkin_v1'),
          AsyncStorage.getItem('@coach_difficulty_checkin_v1'),
        ]);
        if (feelingRaw) {
          const parsed = JSON.parse(feelingRaw) as { date?: string; value?: string | null };
          if (parsed.date === today) {
            setFeelingAsked(true);
            if (parsed.value === 'fresh' || parsed.value === 'good' || parsed.value === 'tired' || parsed.value === 'sore') {
              setSessionFeeling(parsed.value);
            }
          }
        }
        if (difficultyRaw) {
          const parsed = JSON.parse(difficultyRaw) as { date?: string };
          if (parsed.date === today) setDifficultyAsked(true);
        }
      } catch { /* best-effort — worst case the question shows again */ }
    })();
  }, []);
  const [currentRestTime, setCurrentRestTime] = useState(90);
  const [restTimerInterval, setRestTimerInterval] = useState<ReturnType<typeof setInterval> | null>(null);
  const [isResting, setIsResting] = useState(false);
  // In-flight set-log guard: the ref blocks re-entry synchronously (state
  // updates are async), the state dims/disables the pill while a save runs.
  const isLoggingSetRef = useRef(false);
  const [isLoggingSet, setIsLoggingSet] = useState(false);

  // Weight unit and equipment-based logging state
  const [userWeightUnit, setUserWeightUnit] = useState<'kg' | 'lbs'>('kg');

  // Plate options for each unit system (standard gym plates)
  const PLATES_LBS = [45, 35, 25, 10, 5, 2.5] as const;
  const PLATES_KG = [20, 15, 10, 5, 2.5, 1.25] as const;
  const BAR_WEIGHT_LBS = 45;
  const BAR_WEIGHT_KG = 20;

  // Get current plate options based on user preference
  const currentPlates = userWeightUnit === 'lbs' ? PLATES_LBS : PLATES_KG;
  const currentBarWeight = userWeightUnit === 'lbs' ? BAR_WEIGHT_LBS : BAR_WEIGHT_KG;

  // Scheduled notification ID for cancellation when rest is skipped
  const scheduledNotificationIdRef = useRef<string | null>(null);

  // Notification and UI state
  // Ref (not state): only read inside timer closures, and a ref can't go
  // stale between the permission request at rest-start and the scheduling
  // call that follows it in the same tick.
  const notificationPermissionRef = useRef(false);
  const [isShowingScrollAlert, setIsShowingScrollAlert] = useState(false);
  const [isListModeOpen, setIsListModeOpen] = useState(false);
  const [isSwapModalOpen, setIsSwapModalOpen] = useState(false);
  const [swapReason, setSwapReason] = useState<SwapReason | null>(null);
  const [quotaError, setQuotaError] = useState<QuotaExceededError | null>(null);

  // VOICE COACH STASHED (not shipping this version): the voiceMode service
  // subscription, live-context streaming, and mic toggle previously lived here.
  // Removed so the screen has no dependency on react-native-webrtc. See git
  // history / the *.stashed source files to restore.
  const { showAd: showInterstitialAd } = useInterstitialAd();
  const exerciseAdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restAdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isReordering, setIsReordering] = useState(false);
  const [completedExerciseIndexes, setCompletedExerciseIndexes] = useState<number[]>([]);
  const [listModeItems, setListModeItems] = useState<ListModeItem[]>([]);
  const isProgrammaticJumpRef = useRef(false);
  const [isWorkoutComplete, setIsWorkoutComplete] = useState(false);
  // Once the workout completes we clear the persisted session; this ref blocks
  // every later save (unmount cleanup, debounced timers, background events)
  // from resurrecting it — otherwise home shows "Continue" on a done workout.
  const isWorkoutCompleteRef = useRef(false);
  // Set when this session produced a PR — drives the share-your-PR button.
  const [sessionPR, setSessionPR] = useState<{ exercise: string; value: string } | null>(null);

  const completedExerciseIndexSet = useMemo(
    () => new Set(completedExerciseIndexes),
    [completedExerciseIndexes]
  );

  // Every set logged this session, keyed by absolute exercise index. Unlike
  // exerciseProgress.setsCompleted (current exercise only, reset on advance),
  // this survives moving between exercises — it powers the completed-page
  // summaries, the "Edit sets" correction flow, and resuming a deferred
  // exercise's partial progress. Persisted with the session.
  const [sessionSetLog, setSessionSetLog] = useState<Record<number, ExercisePerformanceLog[]>>({});
  // Absolute index of the completed exercise whose sets are being edited (null = closed).
  const [editSetsIndex, setEditSetsIndex] = useState<number | null>(null);

  const serializeSessionSetLog = (log: Record<number, ExercisePerformanceLog[]>) => {
    const out: Record<number, any[]> = {};
    Object.entries(log).forEach(([k, sets]) => {
      out[Number(k)] = sets.map((s) => ({
        ...s,
        workout_date: s.workout_date instanceof Date ? s.workout_date.toISOString() : s.workout_date,
      }));
    });
    return out;
  };

  const parseSessionSetLog = (raw: unknown): Record<number, ExercisePerformanceLog[]> => {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<number, ExercisePerformanceLog[]> = {};
    Object.entries(raw as Record<string, any[]>).forEach(([k, sets]) => {
      if (!Array.isArray(sets)) return;
      out[Number(k)] = sets.map((s) => ({
        ...s,
        workout_date: typeof s.workout_date === 'string' ? new Date(s.workout_date) : s.workout_date,
      }));
    });
    return out;
  };

  // Session management
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(sessionId || null);
  const saveProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedProgressRef = useRef(false);
  const isInitialMountRef = useRef(true);
  const timerRef = useRef(0); // Ref to store timer value without causing re-renders
  const cachedSessionRef = useRef<any>(null); // Cache session to avoid repeated getSession calls
  const startGlobalRestTimer = useWorkoutStore((state) => state.startRestTimer);
  const clearGlobalRestTimer = useWorkoutStore((state) => state.clearRestTimer);

  // Scope the ad governor's per-workout interstitial cap to this player's
  // lifetime (rest-window + dwell ads both route through it).
  useEffect(() => {
    useAdGovernor.getState().beginWorkoutAdSession();
    return () => {
      useAdGovernor.getState().endWorkoutAdSession();
    };
  }, []);
  // Anchor for the Live Activity's elapsed-workout timer. Resolved once per
  // mount (preferring the persisted session's start when resuming) so periodic
  // re-syncs never reset the visible elapsed time.
  const workoutStartMsRef = useRef(0);
  const getWorkoutStartMs = () => {
    if (!workoutStartMsRef.current) {
      const startedAt = cachedSessionRef.current?.startedAt;
      const parsed = startedAt ? new Date(startedAt).getTime() : NaN;
      workoutStartMsRef.current = Number.isFinite(parsed) ? parsed : Date.now();
    }
    return workoutStartMsRef.current;
  };
  const globalRestEndTime = useWorkoutStore((state) => state.restEndTime);
  const restTrigger = useWorkoutStore((state) => state.restTrigger);
  const { tier } = useUserQuota();
  const createSessionId = () => Crypto.randomUUID();

  const ensureSessionInitialized = useCallback(async (): Promise<string | null> => {
    if (currentSessionId) return currentSessionId;
    if (!structuredExercises.length) return null;

    const sessionType = (workoutTypeRef.current || workoutTypeProp || 'main_plan') as 'main_plan' | 'extra_workout' | 'saved_workout' | 'replacement_workout';
    const existing = await getActiveWorkoutSession(sessionType);
    if (existing?.id) {
      setCurrentSessionId(existing.id);
      cachedSessionRef.current = existing;
      return existing.id;
    }

    const newSession = {
      id: createSessionId(),
      workoutType: sessionType,
      workoutName: 'Workout',
      exercises: structuredExercises.map((exercise) => exercise.name),
      structuredExercises,
      startedAt: new Date().toISOString(),
      current_exercise_index: 0,
      current_set: 1,
      total_sets: structuredExercises[0]?.sets || 3,
      sets_completed: [],
      completed_exercise_indexes: [],
      is_resting: false,
      rest_time_remaining: undefined,
      rest_time_duration: undefined,
      rest_end_time: undefined,
    };

    await saveActiveWorkoutSession(newSession as any);
    setCurrentSessionId(newSession.id);
    cachedSessionRef.current = newSession;
    return newSession.id;
  }, [currentSessionId, structuredExercises, workoutTypeProp]);

  /**
   * Get exercise image/GIF URL
   * Data comes from Supabase via structuredExercises.gif_path
   * NO external API calls - all data is pre-loaded
   * 
   * @param exercise - Current exercise object
   * @param index - Exercise index in the list
   * @returns URL string for exercise GIF
   */
  const getExerciseGif = (exercise: Exercise, absoluteIndex: number): string => {
    // Get GIF from structured exercise data (guaranteed by backend)
    const structuredEx = structuredExercises[absoluteIndex];

    if (structuredEx?.gif_path) {
      // Use Supabase Storage URL
      const supabaseUrl = getExerciseGifUrl(structuredEx.gif_path);
      if (supabaseUrl) {
        return supabaseUrl;
      }
    }

    // Fallback: return empty string (backend should always provide gif_path)
    console.warn(`No GIF path for exercise: ${exercise.name}`);
    return '';
  };

  /**
   * Load saved workout progress from session
   * Only loads once to prevent infinite loops
   */
  const loadSavedProgress = useCallback(async () => {
    if (hasLoadedProgressRef.current) return;

    hasLoadedProgressRef.current = true;

    // Ensure we're still in initial mount when loading
    const wasInInitialMount = isInitialMountRef.current;

    try {
      // Get session by workout type first (if we have it) to avoid conflicts
      const sessionType = workoutTypeRef.current;
      let session: any = null;

      if (sessionType) {
        // Load by workout type to get the correct session
        session = await getActiveWorkoutSession(sessionType as any);
      } else {
        // Fallback: try to get any session and match by ID
        session = await getActiveWorkoutSession();
      }

      // Verify session ID matches when one is explicitly provided
      if (!session || (sessionId && session.id !== sessionId)) {
        hasLoadedProgressRef.current = false; // Reset if session doesn't match
        return;
      }

      // Store workout type for this session
      if (session.workoutType) {
        workoutTypeRef.current = session.workoutType;
      } else if (workoutTypeProp) {
        workoutTypeRef.current = workoutTypeProp;
      }

      // Restore structuredExercises from session if not provided as prop
      const restoredExercises: ExerciseCard[] =
        session.structuredExercises && session.structuredExercises.length > 0
          ? session.structuredExercises
          : structuredExercises;
      if (session.structuredExercises && session.structuredExercises.length > 0) {
        setStructuredExercises(session.structuredExercises);
      }

      // Temporarily disable saving while loading
      isInitialMountRef.current = true;

      // Restore exercise progress
      if (session.current_exercise_index !== undefined) {
        // Convert sets_completed from saved format to ExercisePerformanceLog format
        const restoredSetsCompleted: ExercisePerformanceLog[] = (session.sets_completed || []).map((set: any) => ({
          exercise_name: set.exercise_name,
          set_number: set.set_number,
          reps_completed: set.reps_completed,
          weight_used: set.weight_used,
          workout_date: typeof set.workout_date === 'string' ? new Date(set.workout_date) : set.workout_date,
        }));

        // The persisted `session.total_sets` is a single global value (the
        // first exercise's set count) and goes stale across exercises/plans.
        // The structured exercise's own `sets` is the source of truth, so the
        // card always reflects the plan — preventing a 3-set exercise from
        // running a phantom 4th set (3/4 → 4/4 → skip).
        const restoredExercise = restoredExercises[session.current_exercise_index];
        const restoredTotalSets = restoredExercise?.sets ?? session.total_sets ?? 3;

        setExerciseProgress({
          exerciseIndex: session.current_exercise_index,
          currentSet: session.current_set || 1,
          totalSets: restoredTotalSets,
          setsCompleted: restoredSetsCompleted,
        });

        // Update prevProgressRef to match loaded values
        prevProgressRef.current = {
          exerciseIndex: session.current_exercise_index,
          currentSet: session.current_set || 1,
          totalSets: restoredTotalSets,
          setsCompletedLength: restoredSetsCompleted.length,
          isResting: session.is_resting || false,
        };

        // Restore scroll position after exercises are loaded
        setCurrentIndex(session.current_exercise_index || 0);
      }
      const persistedCompletedIndexes = Array.isArray(session.completed_exercise_indexes)
        ? session.completed_exercise_indexes
          .filter((value: unknown) => typeof value === 'number')
          .map((value: number) => value)
          .filter((value: number) => value >= 0 && value < restoredExercises.length)
        : [];
      const migratedCompletedIndexes =
        persistedCompletedIndexes.length > 0
          ? persistedCompletedIndexes
          : Array.isArray(session.completed_exercise_ids)
            ? convertLegacyCompletedIdsToIndexes(session.completed_exercise_ids, restoredExercises)
            : [];
      setCompletedExerciseIndexes(migratedCompletedIndexes);
      setSessionSetLog(parseSessionSetLog(session.session_set_log));

      // Restore the per-exercise elapsed anchor so the top pill's clock
      // resumes instead of resetting on re-entry. The index change applied
      // above will fire the reset effect — skip that one run (only needed
      // when the index actually changes from its initial 0).
      if (session.exercise_started_at) {
        const parsedExerciseStart = new Date(session.exercise_started_at).getTime();
        if (Number.isFinite(parsedExerciseStart)) {
          if ((session.current_exercise_index || 0) > 0) {
            skipNextExerciseStartResetRef.current = true;
          }
          setExerciseStartedAt(parsedExerciseStart);
        }
      }

      // Re-anchor the Live Activity's elapsed-workout timer to the session's
      // original start (the mount-time sync may have already cached Date.now()).
      if (session.startedAt) {
        const parsedStart = new Date(session.startedAt).getTime();
        if (Number.isFinite(parsedStart)) {
          workoutStartMsRef.current = parsedStart;
        }
      }

      // Restore rest timer state if applicable
      if (session.is_resting) {
        setIsResting(true);

        if (session.rest_end_time) {
          // Timestamp-based restoration (robust for background)
          const endTime = new Date(session.rest_end_time).getTime();
          const now = Date.now();

          if (endTime > now) {
            // Timer still running
            const remaining = Math.ceil((endTime - now) / 1000);
            const duration = session.rest_time_duration || 90;
            setRestEndTime(endTime);
            setCurrentRestTime(duration);
            const activeExercise = (session.structuredExercises || structuredExercises)[session.current_exercise_index || 0];
            startGlobalRestTimer({
              exerciseId: activeExercise?.id,
              exerciseName: activeExercise?.name ?? 'Next exercise',
              upcomingSetNumber: session.current_set || 1,
              restDurationSeconds: remaining,
            });
            startRestTimer(remaining, endTime);
            // Re-anchor the iOS Live Activity to the resumed rest countdown.
            liveActivity.start({
              exerciseName: activeExercise?.name ?? 'Next exercise',
              setNumber: session.current_set || 1,
              totalSets: session.total_sets || 0,
              exerciseIndex: (session.current_exercise_index || 0) + 1,
              totalExercises: (session.structuredExercises || structuredExercises).length,
              isResting: true,
              endTimeMs: endTime,
              workoutStartMs: getWorkoutStartMs(),
              gifUrl: activeExercise?.gif_path
                ? getExerciseGifUrl(activeExercise.gif_path) || undefined
                : undefined,
            });
          } else {
            // Timer expired while away — rest is over, back to lifting.
            // (The set was already logged before rest started.)
            setIsResting(false);
            setRestTimeRemaining(0);
            setCurrentRestTime(session.rest_time_duration || 90);
          }
        } else if (session.rest_time_remaining && session.rest_time_duration) {
          // Legacy/fallback fallback
          setRestTimeRemaining(session.rest_time_remaining);
          setCurrentRestTime(session.rest_time_duration);
          startRestTimer(session.rest_time_remaining);
        }
      }

      setCurrentSessionId(session.id);
      // Cache the session to avoid repeated fetches
      cachedSessionRef.current = session;

      // The initial mount useEffect will handle re-enabling saves
      // Don't set it here to avoid conflicts
    } catch (error) {
      console.error('Error loading saved progress:', error);
      hasLoadedProgressRef.current = false; // Reset on error
      isInitialMountRef.current = false; // Re-enable saving on error
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, startGlobalRestTimer, structuredExercises]);

  // Store workout type for this session
  const workoutTypeRef = useRef<string | undefined>(workoutTypeProp);

  // Get workout type from props first, then from session if needed
  useEffect(() => {
    if (workoutTypeProp) {
      workoutTypeRef.current = workoutTypeProp;
    } else if (sessionId) {
      // Fallback: get from session if not provided as prop
      getActiveWorkoutSession().then(session => {
        if (session) {
          workoutTypeRef.current = session.workoutType;
        }
      });
    }
  }, [workoutTypeProp, sessionId]);

  const persistCheckpoint = useCallback(async (overrides: Record<string, unknown>) => {
    const ensuredSessionId = await ensureSessionInitialized();
    if (!ensuredSessionId) return;

    const sessionType = workoutTypeRef.current;
    const latestSession = sessionType
      ? await getActiveWorkoutSession(sessionType as any)
      : await getActiveWorkoutSession();

    if (!latestSession) return;
    const nextSession = {
      ...latestSession,
      ...overrides,
    };
    await saveActiveWorkoutSession(nextSession as any);
    cachedSessionRef.current = nextSession;
  }, [ensureSessionInitialized]);

  function convertLegacyCompletedIdsToIndexes(completedIds: string[], exerciseList: ExerciseCard[]) {
    const usedIndexes = new Set<number>();
    const converted: number[] = [];

    completedIds.forEach((exerciseId) => {
      const matchIndex = exerciseList.findIndex(
        (exercise, index) => exercise.id === exerciseId && !usedIndexes.has(index)
      );
      if (matchIndex >= 0) {
        usedIndexes.add(matchIndex);
        converted.push(matchIndex);
      }
    });

    return converted;
  }

  const normalizeEquipment = useCallback((equipment: string | null | undefined) => {
    if (!equipment || equipment.trim().length === 0) return 'Body Weight';
    return equipment
      .split('_')
      .join(' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }, []);

  const buildListModeItems = useCallback(
    (exerciseList: ExerciseCard[], completedIndexes: number[], currentIndex: number, hasStartedCurrent: boolean): ListModeItem[] => {
      const completedSet = new Set(completedIndexes);
      const idCounts = new Map<string, number>();
      return exerciseList.map((exercise, absoluteIndex) => {
        const isCompleted = completedSet.has(absoluteIndex);
        const isCurrent = absoluteIndex === currentIndex;
        const isLocked = isCompleted || (isCurrent && hasStartedCurrent);
        const occurrence = idCounts.get(exercise.id) ?? 0;
        idCounts.set(exercise.id, occurrence + 1);
        return {
          exercise,
          absoluteIndex,
          instanceKey: `${exercise.id}#${occurrence}`,
          isLocked,
          isCurrent,
          isCompleted,
          equipmentLabel: (exercise as any).equipment_display || normalizeEquipment(exercise.equipment),
        };
      });
    },
    [normalizeEquipment]
  );

  const handleListDragEnd = useCallback(({ data }: { data: ListModeItem[] }) => {
    setIsReordering(false);

    // Keep locked items (completed + in-progress current) at their exact absolute positions.
    // Unlocked items fill the remaining slots in the order the user dragged them.
    const completedSet = new Set(completedExerciseIndexes);
    const isLockedPosition = (idx: number) =>
      completedSet.has(idx) || (idx === exerciseProgress.exerciseIndex && exerciseProgress.currentSet > 1);

    const reorderedUnlocked = data.filter((item) => !item.isLocked).map((item) => item.exercise);
    let unlockIdx = 0;
    const nextStructured = structuredExercises.map((ex, i) =>
      isLockedPosition(i) ? ex : reorderedUnlocked[unlockIdx++]
    );

    setStructuredExercises(nextStructured);
    setListModeItems(
      buildListModeItems(nextStructured, completedExerciseIndexes, exerciseProgress.exerciseIndex, exerciseProgress.currentSet > 1)
    );

    void persistCheckpoint({
      structuredExercises: nextStructured,
      exercises: nextStructured.map((exercise) => exercise.name),
      completed_exercise_indexes: completedExerciseIndexes,
    });
  }, [
    buildListModeItems,
    completedExerciseIndexes,
    exerciseProgress.currentSet,
    exerciseProgress.exerciseIndex,
    persistCheckpoint,
    structuredExercises,
  ]);

  /**
   * Save workout progress to session
   */
  const saveProgress = useCallback(async () => {
    // Skip saving during initial mount / while loadSavedProgress is restoring,
    // to avoid loops and clobbering the just-loaded state.
    if (isInitialMountRef.current) {
      return;
    }

    // The session was cleared on completion — never write it back.
    if (isWorkoutCompleteRef.current) {
      return;
    }

    // Prevent saving if exercises aren't loaded yet
    if (structuredExercises.length === 0) {
      return;
    }

    try {
      // Guarantee a persisted session exists before saving. This used to bail
      // when no session was found, so backgrounding (or force-quitting) the app
      // before the init effect finished silently dropped ALL progress — leaving
      // nothing to resume. ensureSessionInitialized reuses the existing session
      // or creates one, so a save is never a no-op once a workout is underway.
      const ensuredSessionId = await ensureSessionInitialized();
      if (!ensuredSessionId) {
        return;
      }

      // Use cached session if available, otherwise fetch it
      let session = cachedSessionRef.current;
      if (!session) {
        const sessionType = workoutTypeRef.current;
        session = sessionType
          ? await getActiveWorkoutSession(sessionType as any)
          : await getActiveWorkoutSession();

        if (session) {
          cachedSessionRef.current = session;
        }
      }

      if (!session) {
        return;
      }

      // Verify this is the correct session
      if (sessionId && session.id !== sessionId && session.id !== currentSessionId) {
        return;
      }

      // Prepare progress data - only save rest timer state when resting starts/stops, not every second
      const progressData = {
        ...session,
        current_exercise_index: exerciseProgress.exerciseIndex,
        current_set: exerciseProgress.currentSet,
        total_sets: exerciseProgress.totalSets,
        sets_completed: exerciseProgress.setsCompleted.map(set => ({
          exercise_name: set.exercise_name,
          set_number: set.set_number,
          reps_completed: set.reps_completed,
          weight_used: set.weight_used,
          workout_date: set.workout_date.toISOString(),
        })),
        completed_exercise_indexes: completedExerciseIndexes,
        session_set_log: serializeSessionSetLog(sessionSetLog),
        exercise_started_at: new Date(exerciseStartedAt).toISOString(),
        rest_time_remaining: isResting ? restTimeRemaining : undefined,
        rest_time_duration: isResting ? currentRestTime : undefined,
        is_resting: isResting,
        rest_end_time: isResting && restEndTime ? new Date(restEndTime).toISOString() : undefined,
      };

      await saveActiveWorkoutSession(progressData);
      // Update cached session after save
      cachedSessionRef.current = progressData;
    } catch (error) {
      console.error('Error saving progress:', error);
      // Clear cache on error
      cachedSessionRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureSessionInitialized, currentSessionId, sessionId, exerciseProgress.exerciseIndex, exerciseProgress.currentSet, exerciseProgress.totalSets, exerciseProgress.setsCompleted.length, completedExerciseIndexes, sessionSetLog, isResting, restEndTime, structuredExercises.length, exerciseStartedAt]);

  // Store saveProgress in a ref so debounced function can always access latest version
  const saveProgressRef = useRef(saveProgress);
  useEffect(() => {
    saveProgressRef.current = saveProgress;
  }, [saveProgress]);

  // Track if save is in progress to prevent overlapping saves
  const isSavingRef = useRef(false);
  const lastSaveTimeRef = useRef<number>(0);
  const SAVE_COOLDOWN_MS = 3000; // Minimum 3 seconds between saves

  /**
   * Debounced save progress function with cooldown
   */
  const debouncedSaveProgress = useCallback(() => {
    // Skip during initial mount
    if (isInitialMountRef.current) {
      return;
    }

    // Skip if already saving
    if (isSavingRef.current) {
      return;
    }

    // Check cooldown - don't save if we just saved recently
    const now = Date.now();
    const timeSinceLastSave = now - lastSaveTimeRef.current;
    if (timeSinceLastSave < SAVE_COOLDOWN_MS) {
      return;
    }

    // Clear existing timeout
    if (saveProgressTimeoutRef.current) {
      clearTimeout(saveProgressTimeoutRef.current);
    }

    // Set new timeout
    saveProgressTimeoutRef.current = setTimeout(() => {
      if (!isInitialMountRef.current && !isSavingRef.current) {
        isSavingRef.current = true;
        lastSaveTimeRef.current = Date.now();
        saveProgressRef.current().finally(() => {
          isSavingRef.current = false;
        });
      }
    }, 2000); // Debounce by 2 seconds
  }, []);

  // NO data-fetching useEffect needed - exercises are initialized from props
  // structuredExercises is already set in useState initializer

  // Load saved progress when sessionId is available and structured exercises are ready (only once)
  useEffect(() => {
    // Prevent multiple loads
    if (hasLoadedProgressRef.current && structuredExercises.length > 0) return;

    // Wait for exercises to be available before proceeding
    if (!structuredExercises.length) return;

    loadSavedProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, structuredExercises.length]);

  useEffect(() => {
    if (hasLoadedProgressRef.current || !structuredExercises.length) return;
    ensureSessionInitialized().then(() => {
      setExerciseProgress({
        exerciseIndex: 0,
        currentSet: 1,
        totalSets: structuredExercises[0]?.sets || 3,
        setsCompleted: [],
      });
      hasLoadedProgressRef.current = true;
    });
  }, [ensureSessionInitialized, structuredExercises, hasLoadedProgressRef.current]);

  // Mark initial mount as complete after exercises are loaded
  // This prevents saving during the initial setup phase
  useEffect(() => {
    if (exercises.length > 0 && structuredExercises.length > 0 && hasLoadedProgressRef.current) {
      // Wait for everything to stabilize before enabling auto-save
      // Only enable if we've finished loading (either saved progress or new workout)
      const timer = setTimeout(() => {
        isInitialMountRef.current = false;
      }, 5000); // Wait 5 seconds total for everything to settle

      return () => clearTimeout(timer);
    }
  }, [exercises.length, structuredExercises.length, hasLoadedProgressRef.current]);

  // Restore scroll position after exercises are loaded (pager index ==
  // absolute index now that completed pages stay in the pager)
  useEffect(() => {
    if (exercises.length > 0 && exerciseProgress.exerciseIndex > 0 && flatListRef.current) {
      // Small delay to ensure FlatList is ready
      setTimeout(() => {
        flatListRef.current?.scrollToIndex({
          index: exerciseProgress.exerciseIndex,
          animated: false,
        });
      }, 300);
    }
  }, [exerciseProgress.exerciseIndex, exercises.length]);

  // Save progress whenever it changes (but not during initial mount)
  // Use a ref to track previous values and only save if actually changed
  // Note: restTimeRemaining is NOT tracked to prevent saves every second during timer countdown
  const prevProgressRef = useRef({
    exerciseIndex: 0,
    currentSet: 1,
    totalSets: 3,
    setsCompletedLength: 0,
    isResting: false,
  });

  // Bridge: when the user taps "Skip Rest" in the iOS Live Activity (Dynamic Island
  // / lock screen widget), drive the same handleSkipRest path the in-app button uses.
  const handleSkipRestRef = useRef<() => void>(() => {});
  useEffect(() => {
    handleSkipRestRef.current = handleSkipRest;
  });
  useEffect(() => {
    const unsubscribe = liveActivity.onSkipRequested(() => {
      handleSkipRestRef.current?.();
    });
    return unsubscribe;
  }, []);

  // Keep the Live Activity (Dynamic Island + lock screen) alive for the whole
  // workout. This effect owns the work phase: it starts the activity when the
  // workout screen comes up and re-syncs it whenever the exercise or set
  // changes (including when a rest ends and isResting flips back to false).
  // Rest transitions are pushed from startRestAfterLoggedSet with the countdown end.
  // Native start() updates an already-running activity in place, so repeated
  // calls are flicker-free.
  //
  // Focus guard: state keeps changing after the user navigates away (the rest
  // interval still flips isResting → false, progress restores fire, etc.).
  // Without the guard this effect would restart the island AFTER the blur
  // cleanup ended it — the "left the workout but it keeps counting" bug.
  useEffect(() => {
    if (!navigation.isFocused()) return;
    if (structuredExercises.length === 0 || isWorkoutComplete || isResting) return;
    const activeExercise = structuredExercises[exerciseProgress.exerciseIndex];
    if (!activeExercise) return;
    liveActivity.start({
      exerciseName: activeExercise.name ?? 'Exercise',
      setNumber: exerciseProgress.currentSet,
      totalSets: exerciseProgress.totalSets,
      exerciseIndex: exerciseProgress.exerciseIndex + 1,
      totalExercises: structuredExercises.length,
      isResting: false,
      workoutStartMs: getWorkoutStartMs(),
      gifUrl: activeExercise.gif_path
        ? getExerciseGifUrl(activeExercise.gif_path) || undefined
        : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    structuredExercises,
    exerciseProgress.exerciseIndex,
    exerciseProgress.currentSet,
    exerciseProgress.totalSets,
    isResting,
    isWorkoutComplete,
  ]);

  // Full re-sync of the island for the CURRENT phase (work or mid-rest).
  // Kept in a render-refreshed ref so the focus effect below can stay stable.
  const syncLiveActivityRef = useRef<() => void>(() => {});
  useEffect(() => {
    syncLiveActivityRef.current = () => {
      if (structuredExercises.length === 0 || isWorkoutComplete) return;
      const activeExercise = structuredExercises[exerciseProgress.exerciseIndex];
      if (!activeExercise) return;
      const restingNow = isResting && !!restEndTime && restEndTime > Date.now();
      liveActivity.start({
        exerciseName: activeExercise.name ?? 'Exercise',
        setNumber: exerciseProgress.currentSet,
        totalSets: exerciseProgress.totalSets,
        exerciseIndex: exerciseProgress.exerciseIndex + 1,
        totalExercises: structuredExercises.length,
        isResting: restingNow,
        ...(restingNow && restEndTime ? { endTimeMs: restEndTime } : {}),
        workoutStartMs: getWorkoutStartMs(),
        gifUrl: activeExercise.gif_path
          ? getExerciseGifUrl(activeExercise.gif_path) || undefined
          : undefined,
      });
    };
  });

  // The island lives exactly as long as the workout screen is FOCUSED:
  //  - blur (back navigation, or another screen pushed on top) → end it,
  //  - regaining focus (e.g. returning from a pushed screen) → re-sync it.
  // Backgrounding the app does NOT blur the screen, so the island correctly
  // survives pocket/lock — that's its whole purpose. App kill is handled
  // natively (willTerminate + stale "Paused" state) and by the cold-launch
  // sweep in app/_layout.
  useFocusEffect(
    useCallback(() => {
      syncLiveActivityRef.current();
      return () => {
        liveActivity.end();
      };
    }, [])
  );

  useEffect(() => {
    if (structuredExercises.length === 0 || isInitialMountRef.current) {
      return; // Skip if not ready or still mounting
    }

    // Check if anything actually changed (excluding restTimeRemaining to prevent saves every second)
    const currentProgress = {
      exerciseIndex: exerciseProgress.exerciseIndex,
      currentSet: exerciseProgress.currentSet,
      totalSets: exerciseProgress.totalSets,
      setsCompletedLength: exerciseProgress.setsCompleted.length,
      isResting: isResting,
    };

    const hasChanged =
      prevProgressRef.current.exerciseIndex !== currentProgress.exerciseIndex ||
      prevProgressRef.current.currentSet !== currentProgress.currentSet ||
      prevProgressRef.current.totalSets !== currentProgress.totalSets ||
      prevProgressRef.current.setsCompletedLength !== currentProgress.setsCompletedLength ||
      prevProgressRef.current.isResting !== currentProgress.isResting;

    if (hasChanged) {
      prevProgressRef.current = currentProgress;
      debouncedSaveProgress();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseProgress.exerciseIndex, exerciseProgress.currentSet, exerciseProgress.totalSets, exerciseProgress.setsCompleted.length, isResting, structuredExercises.length]);

  // Save rest timer state only when resting state changes (start/stop), not every second
  const prevIsRestingRef = useRef(isResting);
  useEffect(() => {
    if (structuredExercises.length === 0 || isInitialMountRef.current) {
      return;
    }

    // Only save when resting state changes (start or stop), not during countdown
    if (prevIsRestingRef.current !== isResting) {
      prevIsRestingRef.current = isResting;
      debouncedSaveProgress();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResting, structuredExercises.length]);

  // Rest-window interstitial: fires 15 s into a rest period that was started
  // by completing a set, and only if there's still at least 30 s of rest left
  // at that moment. The user is paused with nothing to do — golden window.
  useEffect(() => {
    if (tier === 'premium') return;
    if (restAdTimerRef.current) clearTimeout(restAdTimerRef.current);
    if (globalRestEndTime == null) return;
    if (restTrigger !== 'done_set') return;
    restAdTimerRef.current = setTimeout(() => {
      const remainingMs = (useWorkoutStore.getState().restEndTime ?? 0) - Date.now();
      if (remainingMs < 30_000) return;
      showInterstitialAd();
    }, 15_000);
    return () => {
      if (restAdTimerRef.current) clearTimeout(restAdTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalRestEndTime, restTrigger]);

  // Dwell-based interstitial: only fires if the user has been parked on this
  // exercise for 20 s without logging a set and isn't currently resting. This
  // catches users who are watching the demo, not users mid-flow.
  useEffect(() => {
    if (tier === 'premium') return;
    if (exerciseAdTimerRef.current) clearTimeout(exerciseAdTimerRef.current);
    exerciseAdTimerRef.current = setTimeout(() => {
      if (exerciseProgress.setsCompleted.length > 0) return;
      const restEndTime = useWorkoutStore.getState().restEndTime;
      if (restEndTime != null && restEndTime - Date.now() > 0) return;
      showInterstitialAd();
    }, 20_000);
    return () => {
      if (exerciseAdTimerRef.current) clearTimeout(exerciseAdTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseProgress.exerciseIndex]);

  // Save progress on unmount or background
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState.match(/inactive|background/)) {
        // App going to background - save immediately
        saveProgressRef.current();
      }

      if (nextAppState === 'active') {
        // App resuming - check timer
        if (isResting && restEndTime) {
          const now = Date.now();
          if (restEndTime > now) {
            // Update remaining time
            const remaining = Math.ceil((restEndTime - now) / 1000);
            setRestTimeRemaining(remaining);
          } else {
            // Timer expired while backgrounded — the countdown interval will
            // settle isResting on its next tick; just zero the display.
            setRestTimeRemaining(0);
          }
        }
      }
    });

    return () => {
      subscription.remove();
      if (saveProgressTimeoutRef.current) {
        clearTimeout(saveProgressTimeoutRef.current);
      }
      saveProgress();
    };
  }, [saveProgress, isResting, restEndTime]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      // Cleanup timer
      if (restTimerInterval) {
        clearInterval(restTimerInterval);
      }
    };
  }, [restTimerInterval]);

  useEffect(() => {
    if (!globalRestEndTime || isResting) return;
    const remaining = Math.max(0, Math.ceil((globalRestEndTime - Date.now()) / 1000));
    if (remaining <= 0) return;
    setIsResting(true);
    setRestEndTime(globalRestEndTime);
    setRestTimeRemaining(remaining);
    startRestTimer(remaining, globalRestEndTime);
  }, [globalRestEndTime, isResting]);

  // Check (never request) notification permission on mount and load weight
  // unit. Requesting here used to fire the OS dialog the moment a brand-new
  // user entered their FIRST workout — the "start now" onboarding path skips
  // notification-setup by design, so the prompt had zero context and burned
  // iOS's one-shot ask. The request now happens in ensureRestNotificationPermission,
  // right after the user logs a set and a rest countdown starts — the one
  // moment a "ping me when rest is done" permission is self-explanatory.
  useEffect(() => {
    void (async () => {
      const { status } = await Notifications.getPermissionsAsync();
      notificationPermissionRef.current = status === 'granted';
    })();
    loadUserWeightUnit();
  }, []);

  // Load user's weight unit preference
  const loadUserWeightUnit = async () => {
    const unit = await getWeightUnit();
    setUserWeightUnit(unit);
  };

  /**
   * Ask for notification permission in context: called when a rest countdown
   * starts (a set was just logged). If the user already granted or denied,
   * this never shows a dialog — requestPermissionsAsync only prompts while
   * the status is still undetermined.
   */
  const ensureRestNotificationPermission = async (): Promise<void> => {
    if (notificationPermissionRef.current) return;
    try {
      const current = await Notifications.getPermissionsAsync();
      if (current.status === 'granted') {
        notificationPermissionRef.current = true;
        return;
      }
      if (current.status === 'undetermined' && current.canAskAgain) {
        const { status } = await Notifications.requestPermissionsAsync();
        notificationPermissionRef.current = status === 'granted';
        posthog.capture('notification_permission_result', {
          granted: status === 'granted',
          source: 'rest_timer',
        });
        if (status === 'granted') {
          // New grant: register this device for coach pushes right away.
          void import('../utils/pushTokens').then(({ syncPushToken }) => syncPushToken());
        }
      }
    } catch {
      // Permission is a nice-to-have for the rest push; never block the timer.
    }
  };

  /**
   * Determine equipment type and whether weight logging is required
   * @param equipment - Equipment string from exercise data
   * @returns Equipment logging type
   */
  const getEquipmentLoggingType = (equipment: string): 'none' | 'barbell' | 'dumbbell' | 'machine' => {
    const equipLower = equipment.toLowerCase();

    // No weight logging for bodyweight and resistance bands
    if (equipLower === 'body weight' || equipLower.includes('band') || equipLower.includes('assisted')) {
      return 'none';
    }

    // Barbell-style (plate-loaded) exercises — includes Smith machine and trap bar.
    if (
      equipLower.includes('barbell') ||
      equipLower.includes('smith') ||
      equipLower.includes('trap bar') ||
      equipLower.includes('hex bar') ||
      equipLower.includes('ez bar')
    ) {
      return 'barbell';
    }

    // Dumbbell exercises
    if (equipLower.includes('dumbbell')) {
      return 'dumbbell';
    }

    // Machine exercises
    if (equipLower.includes('machine') || equipLower.includes('lever') || equipLower.includes('cable')) {
      return 'machine';
    }

    // Default to dumbbell slider for other equipment
    return 'dumbbell';
  };

  const getWeightStep = () => 2.5;

  const roundToStep = useCallback((value: number) => {
    const step = getWeightStep();
    return Math.round(value / step) * step;
  }, []);

  const getWeightRange = useCallback((equipmentType: 'none' | 'barbell' | 'dumbbell' | 'machine') => {
    if (equipmentType === 'machine') {
      return { min: 2.5, max: 220 };
    }
    return { min: 2.5, max: 150 };
  }, []);

  useEffect(() => {
    setExercises(structuredExercises.map(mapToDisplayExercise));
  }, [mapToDisplayExercise, structuredExercises]);



  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });

  useEffect(() => {
    if (!isListModeOpen) return;
    setListModeItems(
      buildListModeItems(
        structuredExercises,
        completedExerciseIndexes,
        exerciseProgress.exerciseIndex,
        exerciseProgress.currentSet > 1
      )
    );
  }, [
    buildListModeItems,
    completedExerciseIndexes,
    exerciseProgress.currentSet,
    exerciseProgress.exerciseIndex,
    isListModeOpen,
    structuredExercises,
  ]);

  // Make an exercise the ACTIVE one (resets/resumes its progress).
  const jumpToExercise = useCallback((targetIndex: number) => {
    if (targetIndex < 0 || targetIndex >= structuredExercises.length) return;
    const targetTotalSets = structuredExercises[targetIndex]?.sets || 3;
    // Resume partial progress if this exercise was deferred with sets logged.
    const resumedSets = sessionSetLog[targetIndex] ?? [];
    isProgrammaticJumpRef.current = true;
    setCurrentIndex(targetIndex);
    // Jumping to the exercise that is ALREADY active must not reset its live
    // progress (goToCurrentExercise path) — just scroll to it.
    setExerciseProgress((prev) => prev.exerciseIndex === targetIndex ? prev : ({
      ...prev,
      exerciseIndex: targetIndex,
      currentSet: Math.min(resumedSets.length + 1, targetTotalSets),
      totalSets: targetTotalSets,
      setsCompleted: resumedSets,
    }));
    flatListRef.current?.scrollToIndex({
      index: targetIndex,
      animated: true,
    });
    setTimeout(() => {
      isProgrammaticJumpRef.current = false;
    }, 500);
  }, [sessionSetLog, structuredExercises]);

  // Just LOOK at a page (completed exercises) without touching active progress.
  const viewExercise = useCallback((targetIndex: number) => {
    if (targetIndex < 0 || targetIndex >= structuredExercises.length) return;
    isProgrammaticJumpRef.current = true;
    setCurrentIndex(targetIndex);
    flatListRef.current?.scrollToIndex({ index: targetIndex, animated: true });
    setTimeout(() => {
      isProgrammaticJumpRef.current = false;
    }, 500);
  }, [structuredExercises.length]);

  const goToCurrentExercise = useCallback(() => {
    jumpToExercise(exerciseProgress.exerciseIndex);
    listModeSheetRef.current?.dismiss();
  }, [exerciseProgress.exerciseIndex, jumpToExercise]);

  const hasStartedCurrentExercise = exerciseProgress.currentSet > 1;
  const listSheetSnapPoints = useMemo(() => ['70%', '92%'], []);
  const [swapToastName, setSwapToastName] = useState<string | null>(null);

  const swapReasons: Array<{ key: SwapReason; label: string; icon: keyof typeof Ionicons.glyphMap }> = useMemo(
    () => [
      { key: 'equipment_taken', label: 'Equipment taken', icon: 'barbell-outline' },
      { key: 'pain_injury', label: 'Pain or injury', icon: 'medkit-outline' },
      { key: 'too_hard', label: 'Too hard', icon: 'flame-outline' },
      { key: 'other', label: 'Other', icon: 'ellipsis-horizontal' },
    ],
    []
  );



  const currentSwapTarget = structuredExercises[exerciseProgress.exerciseIndex];
  const skeletonPulse = useSharedValue(0.55);

  useEffect(() => {
    skeletonPulse.value = withRepeat(
      withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
      -1,
      true
    );
  }, [skeletonPulse]);

  const skeletonPulseStyle = useAnimatedStyle(() => ({
    opacity: skeletonPulse.value,
  }));

  const alternativesQuery = useQuery({
    queryKey: ['swap_alternatives', currentSwapTarget?.id],
    queryFn: async (): Promise<ExerciseAlternative[]> => {
      if (!currentSwapTarget?.id) return [];
      return backendClient.getExerciseAlternatives(currentSwapTarget.id);
    },
    enabled: Boolean(isSwapModalOpen && swapReason && currentSwapTarget?.id),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const swapMutation = useMutation({
    mutationFn: async (alternative: ExerciseAlternative) => {
      const activeSessionId = currentSessionId || sessionId;
      if (!activeSessionId || !currentSwapTarget) {
        throw new Error('No active session available for swap.');
      }
      return backendClient.swapSessionExercise({
        sessionId: activeSessionId,
        targetIndex: exerciseProgress.exerciseIndex,
        oldExerciseId: currentSwapTarget.id,
        oldExerciseNameHint: currentSwapTarget.name,
        newExerciseId: alternative.id,
      });
    },
    onMutate: async (alternative) => {
      const previousExercises = structuredExercises;
      const targetIndex = exerciseProgress.exerciseIndex;
      const fallbackCurrent = structuredExercises[targetIndex];

      // Close modal immediately for instant feel
      setIsSwapModalOpen(false);
      setSwapReason(null);

      // Show toast
      setSwapToastName(alternative.name);
      setTimeout(() => setSwapToastName(null), 2500);

      if (!fallbackCurrent) {
        return { previousExercises };
      }

      const optimisticReplacement: ExerciseCard = {
        ...fallbackCurrent,
        id: alternative.id,
        name: alternative.name,
        target_muscle: alternative.target_muscle ?? fallbackCurrent.target_muscle ?? null,
        body_part: alternative.body_part ?? fallbackCurrent.body_part ?? null,
        equipment: alternative.equipment ?? fallbackCurrent.equipment ?? null,
        gif_path: alternative.gif_path ?? fallbackCurrent.gif_path ?? null,
      };

      const nextExercises = [...structuredExercises];
      nextExercises[targetIndex] = optimisticReplacement;

      setStructuredExercises(nextExercises);
      await persistCheckpoint({
        structuredExercises: nextExercises,
        exercises: nextExercises.map((exercise) => exercise.name),
        completed_exercise_indexes: completedExerciseIndexes,
      });

      return { previousExercises };
    },
    onError: async (error, _variables, context) => {
      setSwapToastName(null);
      if (context?.previousExercises) {
        setStructuredExercises(context.previousExercises);
        await persistCheckpoint({
          structuredExercises: context.previousExercises,
          exercises: context.previousExercises.map((exercise) => exercise.name),
          completed_exercise_indexes: completedExerciseIndexes,
        });
      }
      if (isQuotaExceededError(error)) {
        setQuotaError(error);
        return;
      }
      toast.error('Swap failed', 'We could not swap that exercise. Please try again.');
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['todays_workout'] });
    },
  });

  const openListMode = useCallback(() => {
    setIsListModeOpen(true);
    listModeSheetRef.current?.present();
  }, []);

  const proGate = useProGate();

  const openSwapModal = useCallback(() => {
    // Hot-swap is Pro: free users see the contextual upgrade sheet describing
    // the swap feature + additional Pro benefits. If they purchase, the gate
    // resolves and the modal opens. If not, the rest of the workout UI stays
    // fully usable — only this control is gated.
    proGate.gate('exercise_swap', () => {
      setIsSwapModalOpen(true);
      setSwapReason(null);
    });
  }, [proGate]);

  const showFinishCurrentExerciseAlert = useCallback(() => {
    if (isShowingScrollAlert) return;
    setIsShowingScrollAlert(true);
    toast.info('Finish current exercise', 'Complete it — or tap the ↷ button to do it later.');
    setTimeout(() => setIsShowingScrollAlert(false), 2000);
  }, [isShowingScrollAlert]);

  const canNavigateAway = useCallback((targetIndex: number) => {
    if (targetIndex === exerciseProgress.exerciseIndex) return true;
    // Completed pages are always browsable (read/edit view) — the focus lock
    // only guards jumping ahead to a NEW exercise mid-way through this one.
    if (completedExerciseIndexSet.has(targetIndex)) return true;
    if (hasStartedCurrentExercise) return false;
    return true;
  }, [completedExerciseIndexSet, exerciseProgress.exerciseIndex, hasStartedCurrentExercise]);

  /**
   * Handles scroll momentum end events for TikTok-style navigation
   * 
   * FUNCTIONALITY:
   * - Calculates current exercise index based on scroll position
   * - Prevents users from skipping exercises without completing all sets
   * - Shows alert and scrolls back if user tries to skip ahead
   * - Allows navigation only when current exercise is complete
   * - Triggers onExerciseChange callback when valid navigation occurs
   * 
   * @param event - Scroll event from FlatList
   */
  const onMomentumScrollEnd = (event: any) => {
    const index = Math.round(event.nativeEvent.contentOffset.y / SCREEN_HEIGHT);
    if (index < 0 || index >= structuredExercises.length) return;
    if (isProgrammaticJumpRef.current) {
      setCurrentIndex(index);
      return;
    }

    if (!canNavigateAway(index)) {
      showFinishCurrentExerciseAlert();
      flatListRef.current?.scrollToIndex({
        index: exerciseProgress.exerciseIndex,
        animated: true,
      });
      return;
    }

    // Allow navigation if on the correct exercise or all sets are complete
    setCurrentIndex(index);
    if (onExerciseChange && exercises[index]) {
      onExerciseChange(exercises[index], index);
    }
  };

  const handleBackPress = () => {
    // Reassure, don't interrogate: progress auto-saves, so leaving is safe —
    // tell the user that instead of blocking the exit with a confirm.
    const hasProgress =
      !isWorkoutComplete &&
      (exerciseProgress.setsCompleted.length > 0 || completedExerciseIndexes.length > 0);
    if (hasProgress) {
      toast.success('Progress saved', 'Resume this workout anytime from Home.');
    }
    exitToPreviousOrHome();
  };

  const handleInstructionsPress = () => {
    const selected = structuredExercises[currentIndex];
    if (selected) {
      setSelectedExercise(mapToDisplayExercise(selected));
    }
    bottomSheetRef.current?.expand();
  };

  const handleLogSetPress = () => {
    // Open the set logger sheet (prefilled with the coach target / last set).
    restBottomSheetRef.current?.snapToIndex(0);
    // Scroll to top when opening
    setTimeout(() => {
      restScrollViewRef.current?.scrollTo({ y: 0, animated: true });
    }, 100);
  };

  // Skip the active rest period (the set is already logged — skipping rest
  // just gets the user back to lifting sooner). Cancels the rest notification.
  const handleSkipRest = () => {
    if (restTimerInterval) {
      clearInterval(restTimerInterval);
      setRestTimerInterval(null);
    }
    if (scheduledNotificationIdRef.current) {
      Notifications.cancelScheduledNotificationAsync(scheduledNotificationIdRef.current).catch(() => {});
      scheduledNotificationIdRef.current = null;
    }
    setIsResting(false);
    setRestEndTime(null);
    clearGlobalRestTimer();
    // The Live Activity stays up for the whole workout; the work-phase sync
    // effect flips it back from rest mode once isResting settles to false.
    restBottomSheetRef.current?.close();
  };

  // Extend the active rest by 30 s — pushes the end timestamp out, reschedules
  // the rest-complete notification, and re-syncs the Dynamic Island countdown.
  const handleExtendRest = () => {
    if (!isResting || !restEndTime) return;
    const newEndTime = Math.max(restEndTime, Date.now()) + 30_000;
    const newRemaining = Math.ceil((newEndTime - Date.now()) / 1000);
    const newDuration = currentRestTime + 30;
    setCurrentRestTime(newDuration);
    setRestEndTime(newEndTime);
    const currentExercise = structuredExercises[exerciseProgress.exerciseIndex];
    startGlobalRestTimer({
      exerciseId: currentExercise?.id,
      exerciseName: currentExercise?.name ?? 'Next exercise',
      upcomingSetNumber: exerciseProgress.currentSet,
      restDurationSeconds: newRemaining,
      trigger: 'resume',
    });
    liveActivity.start({
      exerciseName: currentExercise?.name ?? 'Next exercise',
      setNumber: exerciseProgress.currentSet,
      totalSets: exerciseProgress.totalSets,
      exerciseIndex: exerciseProgress.exerciseIndex + 1,
      totalExercises: structuredExercises.length,
      isResting: true,
      endTimeMs: newEndTime,
      workoutStartMs: getWorkoutStartMs(),
      gifUrl: currentExercise?.gif_path
        ? getExerciseGifUrl(currentExercise.gif_path) || undefined
        : undefined,
    });
    // startRestTimer replaces the countdown interval and the scheduled push
    // with ones anchored to the new end time.
    startRestTimer(newRemaining, newEndTime);
    void persistCheckpoint({
      is_resting: true,
      rest_time_remaining: newRemaining,
      rest_time_duration: newDuration,
      rest_end_time: new Date(newEndTime).toISOString(),
    });
  };

  /**
   * Starts the rest period for the UPCOMING set — called right after a set
   * has been logged (one-step flow: log → rest starts automatically).
   *
   * Rest no longer starts before logging, so a set can never be silently
   * lost by skipping rest without confirming it in the sheet.
   */
  const startRestAfterLoggedSet = async (upcomingSetNumber: number) => {
    const currentExercise = structuredExercises[exerciseProgress.exerciseIndex];
    const restTime = currentExercise?.rest_seconds || 90;

    const endTime = Date.now() + (restTime * 1000);
    setRestEndTime(endTime);
    startGlobalRestTimer({
      exerciseId: currentExercise?.id,
      exerciseName: currentExercise?.name ?? 'Next exercise',
      upcomingSetNumber,
      restDurationSeconds: restTime,
      trigger: 'done_set',
    });

    // Flip the always-on workout Live Activity into rest mode (countdown +
    // skip button on the Dynamic Island / lock screen).
    liveActivity.start({
      exerciseName: currentExercise?.name ?? 'Next exercise',
      setNumber: upcomingSetNumber,
      totalSets: exerciseProgress.totalSets,
      exerciseIndex: exerciseProgress.exerciseIndex + 1,
      totalExercises: structuredExercises.length,
      isResting: true,
      endTimeMs: endTime,
      workoutStartMs: getWorkoutStartMs(),
      gifUrl: currentExercise?.gif_path
        ? getExerciseGifUrl(currentExercise.gif_path) || undefined
        : undefined,
    });

    setCurrentRestTime(restTime);
    setRestTimeRemaining(restTime);
    setIsResting(true);

    try {
      await persistCheckpoint({
        current_exercise_index: exerciseProgress.exerciseIndex,
        current_set: upcomingSetNumber,
        total_sets: exerciseProgress.totalSets,
        is_resting: true,
        rest_time_remaining: restTime,
        rest_time_duration: restTime,
        rest_end_time: new Date(endTime).toISOString(),
      });
    } catch (e) {
      console.error('Failed to persist checkpoint', e);
    }

    // In-context permission ask (no-op unless still undetermined), then the
    // countdown — the rest-complete push inside startRestTimer needs the
    // fresh permission value.
    await ensureRestNotificationPermission();
    startRestTimer(restTime, endTime);
  };

  /**
   * Starts countdown timer for rest period
   * 
   * FUNCTIONALITY:
   * - Creates 1-second interval for countdown updates
   * - Decrements rest time remaining every second
   * - Provides haptic feedback when timer completes
   * - Sends push notification when rest period ends
   * - Cleans up interval when timer reaches zero
   * 
   * NOTIFICATIONS:
   * - Title: "Rest Complete! "
   * - Body: "Your rest is done, get back to your workout!"
   * - Includes vibration pattern and sound
   * 
   * @param duration - Rest duration in seconds
   * @returns Promise<void>
   */
  const startRestTimer = async (duration: number, endTimeTimestamp?: number) => {
    // If we're resuming, use provided timestamp, otherwise calculate it
    const endTime = endTimeTimestamp || (Date.now() + (duration * 1000));
    setRestEndTime(endTime);

    // Initialize timer ref
    // Make sure we start with correct remaining time if resuming
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((endTime - now) / 1000));
    timerRef.current = remaining;
    setRestTimeRemaining(remaining);

    // Schedule notification for when rest completes (works even when app is backgrounded/closed)
    if (notificationPermissionRef.current && remaining > 0) {
      try {
        // Cancel any existing scheduled notification
        if (scheduledNotificationIdRef.current) {
          await Notifications.cancelScheduledNotificationAsync(scheduledNotificationIdRef.current);
        }

        const logoUri = await initializeNotificationLogo();
        // Schedule for absolute time (more accurate)
        const notificationId = await Notifications.scheduleNotificationAsync({
          content: {
            title: "Rest Complete! 💪",
            body: "Your rest is done, get back to your workout!",
            sound: true,
            ...(logoUri && { image: logoUri }),
            priority: Notifications.AndroidNotificationPriority.HIGH,
            vibrate: [0, 250, 250, 250],
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(endTime), // Fire at exact end time
          },
        });
        scheduledNotificationIdRef.current = notificationId;
      } catch (error) {
        console.error('Error scheduling rest notification:', error);
      }
    }

    // Clear any existing interval
    if (restTimerInterval) {
      clearInterval(restTimerInterval);
    }

    // Logic-only interval: it settles isResting/haptics at the end of the
    // countdown. The visible ticking lives entirely inside WorkoutTimerPill (memo'd,
    // derives remaining time from the stable restEndTime timestamp), so this
    // interval must NOT push state every second — that used to re-render the
    // whole pager once per second of rest.
    const interval = setInterval(() => {
      // Calculate remaining time based on timestamp (robust against backgrounding)
      const currentNow = Date.now();
      const newRemaining = Math.max(0, Math.ceil((endTime - currentNow) / 1000));

      timerRef.current = newRemaining;

      if (newRemaining <= 0) {
        clearInterval(interval);
        setRestTimerInterval(null);
        setRestEndTime(null);
        setIsResting(false);
        clearGlobalRestTimer();
        // Haptic when rest naturally finishes
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // The scheduled notification should have already fired at endTime; clear ref as cleanup.
        scheduledNotificationIdRef.current = null;
        // No sheet auto-open here — the set was logged BEFORE rest started;
        // the top button flips back to "Log Set" for the next one.
        setRestTimeRemaining(0);
        timerRef.current = 0;
      }
    }, 1000);
    setRestTimerInterval(interval as any);
  };

  /**
   * Logs a completed set — THE single confirmation step.
   *
   * One-step flow: saves the set to Supabase, advances the set counter, and
   * automatically starts the rest timer for the upcoming set (or moves to the
   * next exercise when this was the last set). The rest timer never runs for
   * an unlogged set anymore.
   *
   * Outcome honesty: the success haptic fires only AFTER the row is
   * confirmed written. A failed/offline save still logs the set LOCALLY and
   * starts rest (a no-signal gym must not brick the player), but says so
   * visibly and captures set_log_failed — so a broken log path shows up in
   * PostHog instead of masquerading as user inactivity.
   */
  const handleLogSet = async (
    weightToLog: number,
    repsToLog?: number,
    source: 'quick_tap' | 'editor' = 'quick_tap'
  ) => {
    // In-flight guard: the save is awaited over the network and the pill
    // stays tappable — without this a double-tap logs the same set twice.
    if (isLoggingSetRef.current) return;

    const finalWeight = weightToLog;

    // Get current exercise from exercises array (has equipment info)
    const exerciseData = exercises[exerciseProgress.exerciseIndex];
    const equipmentType = exerciseData ? getEquipmentLoggingType(exerciseData.equipment) : 'none';

    // Only validate weight for dumbbell/machine equipment (barbell has default bar weight, bodyweight has none)
    if (equipmentType !== 'none' && equipmentType !== 'barbell' && finalWeight === 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      toast.error('Log your weight', 'Enter the weight you lifted for this set.');
      return;
    }

    // Get structured exercise (has sets/reps info)
    const currentExercise = structuredExercises[exerciseProgress.exerciseIndex];
    if (!currentExercise) {
      console.error('currentExercise is undefined!');
      toast.error('Exercise data not found', 'Please restart the workout.');
      return;
    }

    isLoggingSetRef.current = true;
    setIsLoggingSet(true);
    try {
      const targetRepsNum = currentExercise.reps ?
        parseInt(currentExercise.reps.toString().split('-')[0]) : 10;
      const repsValue = (repsToLog && repsToLog > 0) ? repsToLog : targetRepsNum;

      // Convert weight to kg for database storage (database always stores in kg)
      const weightInKg = toKg(finalWeight, userWeightUnit);

      const session = await getSession();
      const saveResult: { success: boolean; id?: string; error?: string } = session
        ? await saveSetPerformance(
            session.user.id,
            currentExercise.name,
            exerciseProgress.currentSet,
            repsValue,
            weightInKg,
            currentExercise.id // REQUIRED: Exercise UUID for proper FK tracking
          )
        : { success: false, error: 'no_session' };

      if (saveResult.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Activation instrumentation: every set, plus a once-ever
        // first_set_logged (the single best predictor of retention — see
        // growth diagnostic). Captured with the true sync outcome so the
        // funnel metric can't lie.
        posthog.capture('set_logged', {
          exercise_index: exerciseProgress.exerciseIndex,
          set_number: exerciseProgress.currentSet,
          workout_type: workoutTypeRef.current ?? 'main_plan',
          source,
          synced: true,
        });
        void AsyncStorage.getItem('@first_set_logged_v1').then((seen) => {
          if (seen) return;
          void AsyncStorage.setItem('@first_set_logged_v1', '1');
          posthog.capture('first_set_logged');
        });
      } else {
        // Offline or server rejection: the workout must stay usable in a
        // no-signal gym, so the set logs locally and rest still starts —
        // but the user is TOLD (the old code advanced silently and dead
        // writes were invisible for weeks).
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        toast.info('Saved on this phone only', "Couldn't reach the server — your workout continues.");
        posthog.capture('set_log_failed', {
          reason: session ? 'save_error' : 'no_session',
          error: saveResult.error ?? 'unknown',
          source,
          advanced_locally: true,
          exercise_index: exerciseProgress.exerciseIndex,
          set_number: exerciseProgress.currentSet,
        });
      }

      // Create performance record for local state (keep the DB row id so a
      // mis-logged set can be corrected later via the Edit sets flow; an
      // unsynced set simply has no id).
      const performance: ExercisePerformanceLog = {
        id: saveResult.id,
        exercise_name: currentExercise.name,
        set_number: exerciseProgress.currentSet,
        reps_completed: repsValue,
        weight_used: finalWeight,
        workout_date: new Date(),
      };

      // Update local state
      const updatedSets = [...exerciseProgress.setsCompleted, performance];
      const loggedExerciseIndex = exerciseProgress.exerciseIndex;
      setSessionSetLog((prev) => ({
        ...prev,
        [loggedExerciseIndex]: [...(prev[loggedExerciseIndex] ?? []), performance],
      }));

      // Set-completion no longer triggers a full-screen ad — it taxed every
      // tap the user makes to progress. The rest-window interstitial fires
      // 15 s into the rest timer instead, when the user has nothing to do.

      const isLastSet = exerciseProgress.currentSet >= exerciseProgress.totalSets;

      // Coach reacts to what was actually logged — but only at moments worth a
      // coach's word (PRs, meaningful shortfalls, sore-day adjustments). On a
      // routine set buildSetReaction returns null and any stale card is cleared.
      try {
        const rec = effectiveRecommendations.find((r) => r.setNumber === exerciseProgress.currentSet) ?? null;
        const ghost = ghostDataBySet[exerciseProgress.currentSet] ?? null;
        const prevSet = exerciseProgress.setsCompleted.length > 0
          ? [...exerciseProgress.setsCompleted].sort((a, b) => b.set_number - a.set_number)[0]
          : null;
        const prevRec = prevSet
          ? effectiveRecommendations.find((r) => r.setNumber === prevSet.set_number) ?? null
          : null;
        const reaction = buildSetReaction({
          exerciseName: currentExercise.name,
          setNumber: exerciseProgress.currentSet,
          totalSets: exerciseProgress.totalSets,
          reps: repsValue,
          weight: finalWeight,
          unit: userWeightUnit,
          isBodyweight: equipmentType === 'none',
          targetReps: rec?.reps ?? targetRepsNum,
          weightStep: minStep(equipmentType, userWeightUnit),
          ghost: ghost ? { weight: ghost.weight, reps: ghost.reps } : null,
          feeling: sessionFeeling,
          isLastSetOfExercise: isLastSet,
          wasShortLastSetToo: !!(prevSet && prevRec && prevSet.reps_completed < prevRec.reps),
        });
        if (reaction) {
          coachReactionIdRef.current += 1;
          setCoachReaction({ id: coachReactionIdRef.current, ...reaction });
        } else {
          setCoachReaction(null);
        }
      } catch { /* a broken reaction must never block set logging */ }

      restBottomSheetRef.current?.close();

      if (isLastSet) {
        // Last set done — clear any running rest and move on to the next exercise.
        if (restTimerInterval) {
          clearInterval(restTimerInterval);
          setRestTimerInterval(null);
        }
        if (scheduledNotificationIdRef.current) {
          Notifications.cancelScheduledNotificationAsync(scheduledNotificationIdRef.current).catch(() => {});
          scheduledNotificationIdRef.current = null;
        }
        setIsResting(false);
        setRestEndTime(null);
        clearGlobalRestTimer();
        moveToNextExercise();

        await persistCheckpoint({
          current_exercise_index: exerciseProgress.exerciseIndex,
          current_set: exerciseProgress.currentSet,
          total_sets: exerciseProgress.totalSets,
          is_resting: false,
          rest_time_remaining: undefined,
          rest_time_duration: undefined,
          rest_end_time: undefined,
        });
      } else {
        // Mid-exercise set — advance the counter and start the rest countdown
        // for the upcoming set. Logging IS completing the set now.
        const nextSetNumber = exerciseProgress.currentSet + 1;
        setExerciseProgress({
          ...exerciseProgress,
          currentSet: nextSetNumber,
          setsCompleted: updatedSets,
        });
        await startRestAfterLoggedSet(nextSetNumber);
      }
    } finally {
      // Always release the guard — a throw anywhere above must never leave
      // logging permanently disabled for the rest of the session.
      isLoggingSetRef.current = false;
      setIsLoggingSet(false);
    }
  };

  /**
   * Moves to the next exercise in the workout
   * 
   * WORKOUT COMPLETION:
   * - Logs workout completion to Supabase for consistency tracking
   * - Shows completion alert with celebration message
   * - Triggers onComplete callback if provided
   * - Navigates back to previous screen
   * 
   * EXERCISE PROGRESSION:
   * - Scrolls to next exercise with animation
   * - Resets progress state for new exercise
   * - Updates total sets based on structured exercise data
   * - Provides haptic feedback for progression
   * 
   * @returns Promise<void>
   */
  const moveToNextExercise = async () => {
    const justCompletedExerciseIndex = exerciseProgress.exerciseIndex;
    let nextCompletedIndexes = completedExerciseIndexes;
    if (!completedExerciseIndexes.includes(justCompletedExerciseIndex)) {
      nextCompletedIndexes = [...completedExerciseIndexes, justCompletedExerciseIndex];
      setCompletedExerciseIndexes(nextCompletedIndexes);
    }
    // Next ACTIVE exercise = first uncompleted after this one; if the tail is
    // all done (e.g. the user deferred an earlier exercise), wrap to the first
    // uncompleted anywhere. No uncompleted left → workout complete.
    const findNextUncompleted = (): number => {
      for (let i = justCompletedExerciseIndex + 1; i < structuredExercises.length; i++) {
        if (!nextCompletedIndexes.includes(i)) return i;
      }
      for (let i = 0; i < structuredExercises.length; i++) {
        if (!nextCompletedIndexes.includes(i)) return i;
      }
      return -1;
    };
    const nextIndex = findNextUncompleted();

    if (nextIndex < 0) {
      // Workout complete! Log the completion
      try {
        const session = await getSession();
        if (session) {
          await logWorkoutCompletion(session.user.id, new Date());

          // Engagement loop (non-blocking): ask for an App Store review at the
          // 10th workout, and refresh the learned-time / weekly / re-engagement
          // local notifications now that we have a fresh completion.
          void (async () => {
            try {
              const { getTotalWorkouts, getTodaysTopPR } = await import(
                '../src/services/ProgressService'
              );
              const {
                maybeRequestReviewAfterWin,
                refreshEngagementNotifications,
              } = await import('../utils/engagementNotifications');

              // Surface a PR share if this session beat a previous best.
              let hitPR = false;
              try {
                const pr = await getTodaysTopPR(session.user.id);
                if (pr) {
                  hitPR = true;
                  const unit = await getWeightUnit();
                  setSessionPR({
                    exercise: pr.exerciseName,
                    value: `${Math.round(toUserUnit(pr.weightKg, unit))} ${unit}`,
                  });
                }
              } catch { /* PR detection is best-effort */ }

              const { total } = await getTotalWorkouts(session.user.id);
              await refreshEngagementNotifications(session.user.id, { force: true });
              // Ask for an App Store review only on a genuine win — the 3rd
              // completed workout or a session that set a PR. Never on launch.
              await maybeRequestReviewAfterWin({ totalWorkouts: total, hitPR });
            } catch (e) {
              console.warn('post-workout engagement hook failed:', e);
            }
          })();
        }
      } catch (error) {
        console.error('Error logging workout completion:', error);
      }

      // Block all future saves BEFORE clearing so a pending debounce/unmount
      // save can't resurrect the session and leave home stuck on "Continue".
      isWorkoutCompleteRef.current = true;
      if (saveProgressTimeoutRef.current) {
        clearTimeout(saveProgressTimeoutRef.current);
        saveProgressTimeoutRef.current = null;
      }
      cachedSessionRef.current = null;

      // Clear active session on completion (only for this workout type) and
      // stamp today's completion so the home card offers "Re-do Workout".
      try {
        const { clearActiveWorkoutSession, markWorkoutCompletedToday } = await import('../utils/storage');
        const workoutType = workoutTypeRef.current || undefined;
        await clearActiveWorkoutSession(workoutType as any);
        await markWorkoutCompletedToday((workoutType as any) || 'main_plan');
      } catch (error) {
        console.error('Error clearing session:', error);
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Workout done — dismiss the always-on Dynamic Island / lock-screen activity.
      liveActivity.end();
      posthog.capture('workout_completed', {
        workout_type: workoutTypeRef.current ?? 'main_plan',
        exercises: structuredExercises.length,
      });
      // First workout done → interstitials may start (ad governor activation gate).
      useAdGovernor.getState().markActivationComplete();
      setIsWorkoutComplete(true);
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Pager index == absolute index (completed pages stay in the pager).
    flatListRef.current?.scrollToIndex({
      index: nextIndex,
      animated: true,
    });

    setCurrentIndex(nextIndex);

    // Update progress state — resuming any sets logged before the exercise
    // was deferred with "Do this later".
    const nextTotalSets = structuredExercises[nextIndex]?.sets || 3;
    const resumedSets = sessionSetLog[nextIndex] ?? [];
    const nextCurrentSet = Math.min(resumedSets.length + 1, nextTotalSets);
    setExerciseProgress({
      exerciseIndex: nextIndex,
      currentSet: nextCurrentSet,
      totalSets: nextTotalSets,
      setsCompleted: resumedSets,
    });

    await persistCheckpoint({
      current_exercise_index: nextIndex,
      current_set: nextCurrentSet,
      total_sets: nextTotalSets,
      structuredExercises,
      exercises: structuredExercises.map((exercise) => exercise.name),
      completed_exercise_indexes: nextCompletedIndexes,
      // Overwrite the previous exercise's sets so a restore in the debounce
      // window doesn't attach them to the NEW exercise.
      sets_completed: resumedSets.map((set) => ({
        exercise_name: set.exercise_name,
        set_number: set.set_number,
        reps_completed: set.reps_completed,
        weight_used: set.weight_used,
        workout_date: set.workout_date instanceof Date ? set.workout_date.toISOString() : set.workout_date,
      })),
    });
  };

  /**
   * "Do this later" — the FREE escape hatch when the rack is taken mid-exercise.
   * Moves the current exercise to the end of the queue, keeps its logged sets
   * (they resume when the user gets back to it), and activates the next
   * uncompleted exercise in place. No gate, no swap required.
   */
  const handleDoLater = useCallback(async () => {
    const idx = exerciseProgress.exerciseIndex;
    const deferred = structuredExercises[idx];
    if (!deferred) return;

    const hasAnotherUncompleted = structuredExercises.some(
      (_, i) => i !== idx && !completedExerciseIndexSet.has(i)
    );
    if (!hasAnotherUncompleted) {
      toast.info('Last exercise', 'This is the only one left — finish it to wrap up.');
      return;
    }

    // Deferring mid-rest: drop the rest countdown, we're changing context.
    if (isResting) handleSkipRest();

    const nextStructured = [
      ...structuredExercises.slice(0, idx),
      ...structuredExercises.slice(idx + 1),
      deferred,
    ];
    const lastIndex = nextStructured.length - 1;
    const remapIndex = (k: number) => (k < idx ? k : k === idx ? lastIndex : k - 1);

    const nextCompleted = completedExerciseIndexes.map(remapIndex);
    const nextLog: Record<number, ExercisePerformanceLog[]> = {};
    Object.entries(sessionSetLog).forEach(([k, sets]) => {
      nextLog[remapIndex(Number(k))] = sets;
    });

    // New active exercise: first uncompleted from this position (the deferred
    // one now sits at the end, so it's naturally last in line).
    const nextCompletedSet = new Set(nextCompleted);
    let newActive = -1;
    for (let i = idx; i < nextStructured.length; i++) {
      if (i !== lastIndex && !nextCompletedSet.has(i)) { newActive = i; break; }
    }
    if (newActive === -1) {
      for (let i = 0; i < idx; i++) {
        if (!nextCompletedSet.has(i)) { newActive = i; break; }
      }
    }
    if (newActive === -1) newActive = lastIndex;

    const newTotalSets = nextStructured[newActive]?.sets || 3;
    const resumedSets = nextLog[newActive] ?? [];
    const newCurrentSet = Math.min(resumedSets.length + 1, newTotalSets);

    setStructuredExercises(nextStructured);
    setCompletedExerciseIndexes(nextCompleted);
    setSessionSetLog(nextLog);
    setExerciseProgress({
      exerciseIndex: newActive,
      currentSet: newCurrentSet,
      totalSets: newTotalSets,
      setsCompleted: resumedSets,
    });

    if (newActive !== idx) {
      isProgrammaticJumpRef.current = true;
      flatListRef.current?.scrollToIndex({ index: newActive, animated: true });
      setTimeout(() => { isProgrammaticJumpRef.current = false; }, 500);
    }
    setCurrentIndex(newActive);

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    toast.success('Saved for later', `${formatExerciseName(deferred.name)} moved to the end of your workout.`);
    posthog.capture('exercise_deferred', {
      exercise_index: idx,
      sets_already_logged: (sessionSetLog[idx] ?? []).length,
    });

    await persistCheckpoint({
      structuredExercises: nextStructured,
      exercises: nextStructured.map((exercise) => exercise.name),
      completed_exercise_indexes: nextCompleted,
      session_set_log: serializeSessionSetLog(nextLog),
      current_exercise_index: newActive,
      current_set: newCurrentSet,
      total_sets: newTotalSets,
      sets_completed: resumedSets.map((set) => ({
        exercise_name: set.exercise_name,
        set_number: set.set_number,
        reps_completed: set.reps_completed,
        weight_used: set.weight_used,
        workout_date: set.workout_date instanceof Date ? set.workout_date.toISOString() : set.workout_date,
      })),
      is_resting: false,
      rest_time_remaining: undefined,
      rest_time_duration: undefined,
      rest_end_time: undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    completedExerciseIndexSet,
    completedExerciseIndexes,
    exerciseProgress.exerciseIndex,
    isResting,
    persistCheckpoint,
    sessionSetLog,
    structuredExercises,
  ]);

  /** "+1 set" mid-exercise — the plan's set count is a default, not a cage. */
  const handleAddSet = useCallback(() => {
    Haptics.selectionAsync();
    const idx = exerciseProgress.exerciseIndex;
    const nextTotal = exerciseProgress.totalSets + 1;
    // Mirror into the structured exercise so a session restore keeps the
    // extra set (restore reads sets from structuredExercises).
    const nextStructured = structuredExercises.map((ex, i) =>
      i === idx ? { ...ex, sets: nextTotal } : ex
    );
    setStructuredExercises(nextStructured);
    setExerciseProgress((prev) => ({ ...prev, totalSets: prev.totalSets + 1 }));
    toast.success('Set added', `${nextTotal} sets for this exercise.`);
    void persistCheckpoint({
      structuredExercises: nextStructured,
      exercises: nextStructured.map((exercise) => exercise.name),
      total_sets: nextTotal,
    });
  }, [exerciseProgress.exerciseIndex, exerciseProgress.totalSets, persistCheckpoint, structuredExercises]);

  /** Done early — close out the exercise with the sets already logged. */
  const handleEndExerciseEarly = useCallback(async () => {
    const done = exerciseProgress.setsCompleted.length;
    if (done === 0) return;
    const ok = await confirmSheet({
      title: 'Finish exercise early?',
      message: `You've logged ${done} of ${exerciseProgress.totalSets} sets. Mark this exercise complete and move on?`,
      confirmLabel: 'Finish early',
    });
    if (!ok) return;
    restBottomSheetRef.current?.close();
    if (restTimerInterval) {
      clearInterval(restTimerInterval);
      setRestTimerInterval(null);
    }
    if (scheduledNotificationIdRef.current) {
      Notifications.cancelScheduledNotificationAsync(scheduledNotificationIdRef.current).catch(() => {});
      scheduledNotificationIdRef.current = null;
    }
    setIsResting(false);
    setRestEndTime(null);
    clearGlobalRestTimer();
    await moveToNextExercise();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseProgress.setsCompleted.length, exerciseProgress.totalSets, restTimerInterval]);

  /**
   * Persist a correction from the Edit sets sheet: local session log + the
   * database row (when we know its id — sets logged this session carry it).
   */
  const handleSaveEditedSet = useCallback((exerciseIndex: number, setNumber: number, weight: number, reps: number) => {
    const entry = (sessionSetLog[exerciseIndex] ?? []).find((s) => s.set_number === setNumber);
    if (!entry) {
      toast.error('Set not found', 'Close the sheet and try again.');
      return;
    }

    // Optimistic local update, kept restorable: on a failed DB write the
    // local log rolls back so the UI never contradicts its own error toast.
    const previousValues = { weight_used: entry.weight_used, reps_completed: entry.reps_completed };
    setSessionSetLog((prev) => ({
      ...prev,
      [exerciseIndex]: (prev[exerciseIndex] ?? []).map((s) =>
        s.set_number === setNumber ? { ...s, weight_used: weight, reps_completed: reps } : s
      ),
    }));

    // Sets logged this session carry their DB row id — correct the row too.
    // The success toast waits for the DB outcome; a failed update must not
    // read as "updated" (same rule as handleLogSet).
    const entryId = entry.id;
    if (entryId) {
      void (async () => {
        try {
          const session = await getSession();
          if (!session) throw new Error('no_session');
          const result = await updateSetPerformance(session.user.id, entryId, reps, toKg(weight, userWeightUnit));
          if (!result.success) throw new Error(result.error ?? 'update_error');
          toast.success('Set updated');
        } catch (error) {
          setSessionSetLog((prev) => ({
            ...prev,
            [exerciseIndex]: (prev[exerciseIndex] ?? []).map((s) =>
              s.set_number === setNumber ? { ...s, ...previousValues } : s
            ),
          }));
          toast.error('Update not saved', 'Check your connection and try again.');
          posthog.capture('set_log_failed', {
            reason: 'update_error',
            error: error instanceof Error ? error.message : 'unknown',
            source: 'edit_sets',
            exercise_index: exerciseIndex,
            set_number: setNumber,
          });
        }
      })();
    } else {
      // Pre-integrity-fix sets may have no row id; the session log (which
      // drives every in-player summary) did update.
      toast.success('Set updated');
    }
  }, [sessionSetLog, userWeightUnit]);

  // Keep the screen awake for the whole active workout — phones sit on the
  // floor with sweaty hands between sets; auto-lock mid-workout is a dead-end
  // (the Live Activity covers backgrounded, not locked-while-open). Released
  // on blur and on workout completion.
  useFocusEffect(
    useCallback(() => {
      const tag = 'workout-player';
      if (!isWorkoutComplete) {
        activateKeepAwakeAsync(tag).catch(() => {});
      }
      return () => {
        try { deactivateKeepAwake(tag); } catch {}
      };
    }, [isWorkoutComplete])
  );

  // Load ghost data for all sets of the current exercise from previous sessions,
  // and compute AI progressive-overload recommendations to prefill the logger.
  const loadAllGhostPerformance = useCallback(async () => {
    setGhostDataBySet({});
    setSetRecommendations([]);
    setCoachNote(null);

    const session = await getSession();
    if (!session) return;

    const currentExercise = structuredExercises[exerciseProgress.exerciseIndex];
    if (!currentExercise) return;

    const { history } = await getExerciseHistory(session.user.id, currentExercise.name, 80);

    // Compute recommendations even with no history (uses plan target as fallback).
    const totalSets = currentExercise.sets || 3;
    const equipmentType = getEquipmentLoggingType(
      exercises[exerciseProgress.exerciseIndex]?.equipment || 'body weight',
    );
    const recs = recommendSets({
      history,
      totalSets,
      targetReps: currentExercise.reps ?? 10,
      equipmentType,
      unit: userWeightUnit,
      planWeight: null,
    });
    setSetRecommendations(recs);
    setCoachNote(
      buildCoachNote({
        recs,
        history,
        unit: userWeightUnit,
        exerciseName: currentExercise.name,
      }),
    );

    if (!history.length) return;

    const groupedByDate = new Map<string, ExercisePerformanceLog[]>();
    history.forEach((entry) => {
      const dateKey = getLocalDateString(entry.workout_date); // local day, not UTC
      const existing = groupedByDate.get(dateKey) || [];
      existing.push(entry);
      groupedByDate.set(dateKey, existing);
    });

    const sortedDates = Array.from(groupedByDate.keys()).sort((a, b) =>
      new Date(b).getTime() - new Date(a).getTime()
    );

    const result: Record<number, { weight: number; reps: number; date: string }> = {};

    let fallbackSet: ExercisePerformanceLog | null = null;
    for (const day of sortedDates) {
      const setsForDay = groupedByDate.get(day) || [];
      if (!fallbackSet) fallbackSet = setsForDay.find((s) => s.weight_used > 0) || null;
    }

    for (let setNum = 1; setNum <= totalSets; setNum++) {
      let matched: ExercisePerformanceLog | null = null;
      for (const day of sortedDates) {
        const setsForDay = groupedByDate.get(day) || [];
        const exact = setsForDay.find((s) => s.set_number === setNum);
        if (exact) { matched = exact; break; }
      }
      const chosen = matched || fallbackSet;
      if (chosen && chosen.weight_used > 0) {
        result[setNum] = {
          weight: roundToStep(toUserUnit(chosen.weight_used, userWeightUnit)),
          reps: chosen.reps_completed || 10,
          date: chosen.workout_date.toLocaleDateString(),
        };
      }
    }

    setGhostDataBySet(result);
  }, [
    exerciseProgress.exerciseIndex,
    roundToStep,
    structuredExercises,
    exercises,
    userWeightUnit,
  ]);

  useEffect(() => {
    if (!structuredExercises.length) return;
    loadAllGhostPerformance();
  }, [loadAllGhostPerformance, structuredExercises.length]);

  // "Last session" numbers for EVERY exercise page (ghostDataBySet only
  // covers the current exercise). Keyed by exercise NAME so reorders and
  // "do later" remaps can't misalign the data with the page.
  const [lastWeekByExercise, setLastWeekByExercise] = useState<
    Record<string, Record<number, { weight: number; reps: number; date: string }>>
  >({});

  useEffect(() => {
    if (!structuredExercises.length) return;
    let cancelled = false;
    void (async () => {
      const session = await getSession();
      if (!session || cancelled) return;
      const result: Record<string, Record<number, { weight: number; reps: number; date: string }>> = {};
      await Promise.all(
        structuredExercises.map(async (ex) => {
          try {
            const { history } = await getExerciseHistory(session.user.id, ex.name, 80);
            if (!history.length) return;
            const grouped = new Map<string, ExercisePerformanceLog[]>();
            history.forEach((entry) => {
              const key = getLocalDateString(entry.workout_date);
              const arr = grouped.get(key) || [];
              arr.push(entry);
              grouped.set(key, arr);
            });
            const dates = Array.from(grouped.keys()).sort(
              (a, b) => new Date(b).getTime() - new Date(a).getTime()
            );
            let fallback: ExercisePerformanceLog | null = null;
            for (const day of dates) {
              if (!fallback) fallback = (grouped.get(day) || []).find((s) => s.weight_used > 0) || null;
            }
            const bySet: Record<number, { weight: number; reps: number; date: string }> = {};
            const plannedSets = ex.sets || 3;
            for (let setNum = 1; setNum <= plannedSets; setNum++) {
              let matched: ExercisePerformanceLog | null = null;
              for (const day of dates) {
                const exact = (grouped.get(day) || []).find((s) => s.set_number === setNum);
                if (exact) { matched = exact; break; }
              }
              const chosen = matched || fallback;
              if (chosen && (chosen.weight_used > 0 || chosen.reps_completed > 0)) {
                bySet[setNum] = {
                  weight: chosen.weight_used > 0 ? roundToStep(toUserUnit(chosen.weight_used, userWeightUnit)) : 0,
                  reps: chosen.reps_completed || 0,
                  date: chosen.workout_date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                };
              }
            }
            if (Object.keys(bySet).length) result[ex.name] = bySet;
          } catch { /* per-exercise history is best-effort */ }
        })
      );
      if (!cancelled) setLastWeekByExercise(result);
    })();
    return () => { cancelled = true; };
  }, [structuredExercises, roundToStep, userWeightUnit]);

  // Feeling-aware recommendations: when the user says they're tired or sore,
  // convert every "increase" into a hold at last session's weight — recovery
  // days bank clean reps instead of chasing new loads. Fresh/good change nothing.
  const effectiveRecommendations = useMemo<SetRecommendation[]>(() => {
    if (sessionFeeling !== 'tired' && sessionFeeling !== 'sore') return setRecommendations;
    return setRecommendations.map((rec) => {
      if (rec.kind !== 'increase') return rec;
      const ghost = ghostDataBySet[rec.setNumber];
      return {
        ...rec,
        kind: 'maintain' as const,
        weight: ghost?.weight ?? rec.weight,
        reasoning: `Holding — you said you're feeling ${sessionFeeling}`,
      };
    });
  }, [setRecommendations, sessionFeeling, ghostDataBySet]);

  const effectiveCoachNote = useMemo<CoachExerciseNote | null>(() => {
    // Tired/sore keeps a short standing reminder on the strip; the per-set
    // coaching itself now comes from the dynamic reaction card, so this no
    // longer needs to restate the whole plan on every exercise.
    if (sessionFeeling === 'tired' || sessionFeeling === 'sore') {
      return {
        text:
          sessionFeeling === 'sore'
            ? 'Holding weights today — full range, stop anything sharp.'
            : 'Holding weights today — bank clean reps.',
        tone: 'recover',
      };
    }
    return coachNote;
  }, [coachNote, sessionFeeling]);

  // The exact commit the one-tap bar will log: previous set in this session,
  // else the coach's overload recommendation for the upcoming set — the same
  // prefill rule ActiveSetEditor uses, so tap-to-log and the sheet agree.
  const quickLogTarget = useMemo(() => {
    const currentExercise = exercises[exerciseProgress.exerciseIndex];
    const equipmentType = currentExercise ? getEquipmentLoggingType(currentExercise.equipment) : 'none';
    const prev =
      exerciseProgress.setsCompleted.length > 0
        ? [...exerciseProgress.setsCompleted].sort((a, b) => b.set_number - a.set_number)[0]
        : undefined;
    const rec = effectiveRecommendations.find((r) => r.setNumber === exerciseProgress.currentSet);
    const weight = prev ? prev.weight_used : rec?.weight ?? 0;
    const reps = prev ? prev.reps_completed : rec?.reps ?? 0;
    const isBodyweight = equipmentType === 'none';
    // Dumbbell/machine sets can't be quick-logged at 0 weight (the logger
    // validates it) — in that state the bar routes to the editor instead.
    const needsWeight = equipmentType === 'dumbbell' || equipmentType === 'machine';
    const canQuickLog = reps > 0 && (!needsWeight || weight > 0);
    return { weight, reps, isBodyweight, canQuickLog };
  }, [effectiveRecommendations, exerciseProgress.currentSet, exerciseProgress.exerciseIndex, exerciseProgress.setsCompleted, exercises]);

  // Question gating: feeling is asked once at the true start of the workout
  // (first exercise, nothing logged); difficulty once past the halfway mark.
  const showFeelingQuestion =
    !feelingAsked &&
    exerciseProgress.exerciseIndex === 0 &&
    exerciseProgress.currentSet === 1 &&
    exerciseProgress.setsCompleted.length === 0 &&
    completedExerciseIndexes.length === 0;

  const showDifficultyQuestion =
    !showFeelingQuestion &&
    !difficultyAsked &&
    structuredExercises.length >= 2 &&
    completedExerciseIndexes.length >= Math.ceil(structuredExercises.length / 2);

  const workoutLabelForFeedback = structuredExercises[0]?.target_muscle
    ? `${structuredExercises[0].target_muscle} day`
    : undefined;

  const handleFeelingAnswer = useCallback((value: string) => {
    setSessionFeeling(value as 'fresh' | 'good' | 'tired' | 'sore');
    setFeelingAsked(true);
    void AsyncStorage.setItem(
      '@coach_feeling_checkin_v1',
      JSON.stringify({ date: getLocalDateString(), value })
    );
    void backendClient.sendSessionFeedback('feeling', value, workoutLabelForFeedback);
  }, [workoutLabelForFeedback]);

  const handleFeelingSkip = useCallback(() => {
    setFeelingAsked(true);
    // A skip counts as "asked today" — don't nag again this day.
    void AsyncStorage.setItem(
      '@coach_feeling_checkin_v1',
      JSON.stringify({ date: getLocalDateString(), value: null })
    );
  }, []);

  const handleDifficultyAnswer = useCallback((value: string) => {
    setDifficultyAsked(true);
    void AsyncStorage.setItem(
      '@coach_difficulty_checkin_v1',
      JSON.stringify({ date: getLocalDateString() })
    );
    void backendClient.sendSessionFeedback('difficulty', value, workoutLabelForFeedback);
  }, [workoutLabelForFeedback]);

  const handleDifficultySkip = useCallback(() => {
    setDifficultyAsked(true);
    void AsyncStorage.setItem(
      '@coach_difficulty_checkin_v1',
      JSON.stringify({ date: getLocalDateString() })
    );
  }, []);

  const FEELING_ACKS: Record<string, string> = {
    fresh: 'Love it — green light to push today.',
    good: "Solid. We'll take what's there.",
    tired: 'Got it — holding weights today, banking clean reps.',
    sore: "Noted — keeping intensity in check. Speak up if anything hurts.",
  };
  const DIFFICULTY_ACKS: Record<string, string> = {
    too_easy: "Noted — I'll nudge your targets up.",
    just_right: "Perfect — that's the zone.",
    too_hard: "Got it — we'll ease off a touch going forward.",
  };

  /**
   * ExerciseItem Component
   * 
   * Renders individual exercise in the TikTok-style scroll view
   * 
   * FEATURES:
   * - Animated scaling and opacity based on scroll position
   * - Exercise image with placeholder and error handling
   * - Set progress tracking with visual indicators
   * - Exercise details (target muscle, equipment)
   * - Instructions button for detailed exercise info
   * - Done button for set completion
   * 
   * ANIMATION:
   * - Scale: 0.8 → 1.0 → 0.8 based on scroll position
   * - Opacity: 0.5 → 1.0 → 0.5 for smooth transitions
   * - Uses React Native Reanimated for performance
   * 
   * @param isResting - Whether resting state is active
   */
  const ExerciseItem = React.memo(({
    exercise,
    pagerIndex,
    absoluteIndex,
    isResting,
    isCurrentExercise,
    isCompleted,
    completedSetsSummary,
    currentSet: itemCurrentSet,
    totalSets: itemTotalSets,
    reps: itemReps,
    intensityTarget,
    injuryNote,
    coachRec,
    coachGhost,
    coachNote: itemCoachNote,
    weightUnit,
    onCoachStripDismiss,
    onEditSets,
    onDoLater,
    coachQuestion,
    lastWeek,
  }: {
    exercise: Exercise;
    pagerIndex: number;
    absoluteIndex: number;
    isResting: boolean;
    isCurrentExercise: boolean;
    isCompleted: boolean;
    /** e.g. "60 kg × 8 · 62.5 kg × 8 · 62.5 kg × 7" for the overlay */
    completedSetsSummary: string | null;
    currentSet: number;
    totalSets: number;
    reps: string | number;
    intensityTarget?: string;
    injuryNote?: string;
    coachRec: SetRecommendation | null;
    coachGhost: { weight: number; reps: number; date: string } | null;
    coachNote: CoachExerciseNote | null;
    weightUnit: 'kg' | 'lbs';
    onCoachStripDismiss: () => void;
    onEditSets: () => void;
    onDoLater: () => void;
    coachQuestion?: React.ReactNode;
    /** Last session's numbers for the set this page is on (all pages). */
    lastWeek: { weight: number; reps: number; date: string } | null;
  }) => {
    // This component should not re-render when timer updates
    const animatedStyle = useAnimatedStyle(() => {
      const inputRange = [
        (pagerIndex - 1) * SCREEN_HEIGHT,
        pagerIndex * SCREEN_HEIGHT,
        (pagerIndex + 1) * SCREEN_HEIGHT,
      ];

      const scale = interpolate(
        scrollY.value,
        inputRange,
        [0.8, 1, 0.8],
        Extrapolate.CLAMP
      );

      const opacity = interpolate(
        scrollY.value,
        inputRange,
        [0.5, 1, 0.5],
        Extrapolate.CLAMP
      );

      return {
        transform: [{ scale }],
        opacity,
      };
    });

    return (
      <Animated.View style={[styles.exerciseContainer, animatedStyle]}>
        {/* Top Bar - Clean layout (the log/rest action lives in the
            WorkoutTimerPill overlay at the top-right of the screen) */}
        <View style={styles.topBar}>
          {/* Left: Back button — 44pt touch target */}
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBackPress}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="chevron-back" size={24} color="#000" />
          </TouchableOpacity>
        </View>

        {/* Exercise GIF using Expo Image */}
        <View style={[styles.imageContainer, isCompleted && styles.imageContainerCompleted]}>
          <Image
            source={{ uri: getExerciseGif(exercise, absoluteIndex) }}
            style={styles.exerciseImage}
            contentFit="contain"
            placeholder={{ blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4' }}
            transition={250}
            onError={(e) => console.error('Image loading error:', e)}
            cachePolicy="memory-disk"
            recyclingKey={`${exercise.id}_${absoluteIndex}`}
            priority="high"
            allowDownscaling={true}
            autoplay={!isResting && !isCompleted} // Pause when resting/done — saves resources
          />
        </View>

        {/* Completed exercise: ✓ overlay with what was logged + Edit sets.
            The page stays in the pager so a mis-logged set is never a dead-end. */}
        {isCompleted && (
          <View style={styles.completedOverlay} pointerEvents="box-none">
            <View style={styles.completedBadge}>
              <Ionicons name="checkmark-circle" size={20} color="#2E90FA" />
              <Text style={styles.completedBadgeText}>Completed</Text>
            </View>
            {completedSetsSummary ? (
              <Text style={styles.completedSummaryText} numberOfLines={2}>
                {completedSetsSummary}
              </Text>
            ) : null}
            <TouchableOpacity
              style={styles.editSetsButton}
              onPress={onEditSets}
              accessibilityRole="button"
              accessibilityLabel="Edit logged sets"
            >
              <Ionicons name="pencil" size={14} color="#111" />
              <Text style={styles.editSetsButtonText}>Edit sets</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* VOICE COACH STASHED: voice captions overlay removed for this version. */}

        {/* Bottom exercise info */}
        <View style={styles.exerciseInfo}>
          <View style={styles.exerciseHeader}>
            <Text style={styles.exerciseName}>{formatExerciseName(exercise.name)}</Text>
            <TouchableOpacity style={styles.instructionsIconButton} onPress={handleInstructionsPress}>
              <Ionicons name="information-circle-outline" size={28} color="#000" />
            </TouchableOpacity>
          </View>

          {/* Metadata pills + action buttons */}
          <View style={styles.pillsRow}>
            <View style={styles.metaPill}>
              <Text style={styles.metaPillText}>{exercise.target}</Text>
            </View>
            <View style={styles.metaPill}>
              <Text style={styles.metaPillText}>{itemReps} reps</Text>
            </View>
            {/* Last session's weight for the set this page is on — inline with
                the other metadata pills, updates as the set counter advances. */}
            {!isCompleted && lastWeek ? (
              <View style={[styles.metaPill, styles.metaPillLast]}>
                <Ionicons name="time-outline" size={11} color="#555" />
                <Text style={styles.metaPillText}>
                  Last: {lastWeek.weight > 0
                    ? `${lastWeek.weight} ${weightUnit} × ${lastWeek.reps}`
                    : `${lastWeek.reps} reps`}
                </Text>
              </View>
            ) : null}
            {intensityTarget ? (
              <View style={[styles.metaPill, styles.metaPillAmber]}>
                <Text style={[styles.metaPillText, styles.metaPillTextAmber]}>
                  {intensityTarget.split(' - ')[0]}
                </Text>
              </View>
            ) : null}
            <TouchableOpacity style={styles.pillIconButton} onPress={openListMode} hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}>
              <Ionicons name="menu-outline" size={15} color="#333" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.pillIconButton} onPress={openSwapModal} hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }} accessibilityLabel="Swap exercise">
              <Ionicons name="swap-horizontal-outline" size={15} color="#333" />
            </TouchableOpacity>
            {/* Free escape hatch: rack taken → push this exercise to the end
                of the queue (keeps logged sets). Not Pro-gated by design. */}
            {isCurrentExercise && !isCompleted && (
              <TouchableOpacity
                style={styles.pillIconButton}
                onPress={onDoLater}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                accessibilityLabel="Do this exercise later"
              >
                <Ionicons name="arrow-redo-outline" size={15} color="#333" />
              </TouchableOpacity>
            )}
            {/* VOICE COACH STASHED: mic toggle button removed for this version. */}
          </View>

          {/* Injury modification cue: proof the plan factored in what they told
              us during setup, shown right where they perform the movement. */}
          {injuryNote ? (
            <View style={styles.injuryNoteRow}>
              <Ionicons name="shield-checkmark" size={14} color="#2E90FA" />
              <Text style={styles.injuryNoteText} numberOfLines={2}>{injuryNote}</Text>
            </View>
          ) : null}

          {/* Coach question (workout start / halfway) takes the guidance slot;
              otherwise the info-only target strip (X-dismissible; logging
              happens via the WorkoutTimerPill, not here). */}
          {isCurrentExercise && coachQuestion ? (
            coachQuestion
          ) : isCurrentExercise ? (
            <CoachTargetStrip
              setNumber={itemCurrentSet}
              totalSets={itemTotalSets}
              rec={coachRec}
              ghost={coachGhost}
              note={itemCoachNote}
              unit={weightUnit}
              isBodyweight={getEquipmentLoggingType(exercise.equipment) === 'none'}
              onDismiss={onCoachStripDismiss}
            />
          ) : null}
        </View>

        {!isCurrentExercise && (
          <Animated.View
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(180)}
            style={styles.goToCurrentPillContainer}
          >
            <TouchableOpacity style={styles.goToCurrentPill} onPress={goToCurrentExercise}>
              <Text style={styles.goToCurrentPillText}>Go to Current</Text>
            </TouchableOpacity>
          </Animated.View>
        )}

      </Animated.View>
    );
  });
  ExerciseItem.displayName = 'ExerciseItem';

  const renderListModeItem = ({ item, drag, isActive }: RenderItemParams<ListModeItem>) => (
    <TouchableOpacity
      style={[
        styles.listRow,
        item.isLocked && styles.listRowLocked,
        isActive && styles.listRowActive,
      ]}
      onLongPress={() => {
        if (!item.isLocked) {
          drag();
        }
      }}
      // Completed rows stay drag-locked but are TAPPABLE: they open the
      // completed page in read/edit view (fixes the mis-log dead-end).
      disabled={item.isLocked && !item.isCompleted}
      onPress={() => {
        const targetIndex = item.absoluteIndex;
        if (targetIndex < 0) return;
        if (item.isCompleted) {
          viewExercise(targetIndex);
          listModeSheetRef.current?.dismiss();
          return;
        }
        if (!canNavigateAway(targetIndex)) {
          showFinishCurrentExerciseAlert();
          return;
        }
        jumpToExercise(targetIndex);
        listModeSheetRef.current?.dismiss();
      }}
    >
      <View style={styles.listRowLeft}>
        <Ionicons
          name={item.isCompleted ? 'checkmark-circle-outline' : item.isLocked ? 'lock-closed-outline' : 'reorder-three-outline'}
          size={18}
          color={item.isLocked ? '#8A8A8A' : '#444'}
        />
        <View style={styles.listRowTextWrap}>
          <Text style={[styles.listRowText, item.isLocked && styles.listRowTextLocked]}>{formatExerciseName(item.exercise.name)}</Text>
          <Text style={styles.equipmentPill}>{item.equipmentLabel}</Text>
        </View>
      </View>
      <View style={styles.listRowRight}>
        {item.isCurrent && <Text style={styles.currentBadge}>Current</Text>}
        {item.isCompleted && (
          <>
            <Ionicons name="checkmark-circle" size={16} color="#9B9B9B" />
            <Ionicons name="chevron-forward" size={14} color="#B5B5B5" />
          </>
        )}
      </View>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2E90FA" />
        <Text style={styles.loadingText}>Loading exercises...</Text>
      </View>
    );
  }

  if (exercises.length === 0 && !loading && !sessionId) {
    // Only show error if we're not loading and not resuming a session
    // (If resuming, exercises might still be loading from session)
    return (
      <View style={styles.errorContainer}>
        <Ionicons name="barbell-outline" size={40} color="#999999" />
        <Text style={styles.errorText}>No exercises found</Text>
        <Text style={styles.errorSubtext}>Something went wrong loading this workout.</Text>
        <TouchableOpacity
          style={styles.errorBackButton}
          onPress={exitToPreviousOrHome}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.errorBackButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (exercises.length === 0 && sessionId && !loading) {
    // Resuming a session — exercises still hydrating from storage
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2E90FA" />
        <Text style={styles.loadingText}>Loading workout...</Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <BottomSheetModalProvider>
        <SafeAreaView style={styles.container}>
          <Animated.FlatList
            ref={flatListRef}
            data={exercises}
            keyExtractor={(_item, index) => `pager-${index}`}
            renderItem={({ item, index }) => {
              const absoluteIndex = index;
              const isCurrent = absoluteIndex === exerciseProgress.exerciseIndex;
              const isCompletedItem = completedExerciseIndexSet.has(absoluteIndex);
              const loggedSets = sessionSetLog[absoluteIndex] ?? [];
              const completedSetsSummary = loggedSets.length
                ? loggedSets
                    .slice()
                    .sort((a, b) => a.set_number - b.set_number)
                    .map((s) =>
                      s.weight_used > 0
                        ? `${s.weight_used} ${userWeightUnit} × ${s.reps_completed}`
                        : `${s.reps_completed} reps`
                    )
                    .join('  ·  ')
                : null;
              // "Last session" data for this page's upcoming set: the live set
              // counter on the current exercise, else first un-logged set.
              const itemExercise = structuredExercises[absoluteIndex];
              const itemPlannedSets = itemExercise?.sets || exerciseProgress.totalSets;
              const lastWeekSetNumber = isCurrent
                ? exerciseProgress.currentSet
                : Math.min(loggedSets.length + 1, itemPlannedSets);
              const lastWeekBySet = itemExercise ? lastWeekByExercise[itemExercise.name] : undefined;
              const lastWeek = lastWeekBySet
                ? lastWeekBySet[lastWeekSetNumber] ?? lastWeekBySet[1] ?? null
                : null;
              return (
                <ExerciseItem
                  exercise={item}
                  pagerIndex={index}
                  absoluteIndex={absoluteIndex}
                  isResting={isResting}
                  isCurrentExercise={isCurrent}
                  isCompleted={isCompletedItem}
                  completedSetsSummary={isCompletedItem ? completedSetsSummary : null}
                  currentSet={exerciseProgress.currentSet}
                  totalSets={exerciseProgress.totalSets}
                  reps={structuredExercises[absoluteIndex]?.reps ?? '—'}
                  intensityTarget={structuredExercises[absoluteIndex]?.intensity_target}
                  injuryNote={structuredExercises[absoluteIndex]?.injury_note}
                  coachRec={
                    isCurrent && stripDismissedForExercise !== exerciseProgress.exerciseIndex
                      ? effectiveRecommendations.find((r) => r.setNumber === exerciseProgress.currentSet) ?? null
                      : null
                  }
                  // Ghost line on the strip retired — the "Last:" pill in the
                  // metadata row is now the single "last session" surface.
                  coachGhost={null}
                  // The note's advice references LAST SESSION, so it's only
                  // accurate before anything is logged this exercise — after
                  // that the per-set reaction card does the coaching.
                  coachNote={
                    isCurrent &&
                    stripDismissedForExercise !== exerciseProgress.exerciseIndex &&
                    exerciseProgress.setsCompleted.length === 0
                      ? effectiveCoachNote
                      : null
                  }
                  lastWeek={lastWeek}
                  weightUnit={userWeightUnit}
                  onCoachStripDismiss={() => setStripDismissedForExercise(exerciseProgress.exerciseIndex)}
                  onEditSets={() => setEditSetsIndex(absoluteIndex)}
                  onDoLater={handleDoLater}
                  coachQuestion={
                    isCurrent && showFeelingQuestion ? (
                      <CoachQuestionCard
                        question="How are you feeling today?"
                        options={[
                          { value: 'fresh', label: 'Fresh' },
                          { value: 'good', label: 'Good' },
                          { value: 'tired', label: 'Tired' },
                          { value: 'sore', label: 'Sore' },
                        ]}
                        acknowledgement={(v) => FEELING_ACKS[v] ?? 'Got it.'}
                        onAnswer={handleFeelingAnswer}
                        onSkip={handleFeelingSkip}
                      />
                    ) : isCurrent && showDifficultyQuestion ? (
                      <CoachQuestionCard
                        question="How's this workout treating you?"
                        options={[
                          { value: 'too_easy', label: 'Too easy' },
                          { value: 'just_right', label: 'Just right' },
                          { value: 'too_hard', label: 'Too hard' },
                        ]}
                        acknowledgement={(v) => DIFFICULTY_ACKS[v] ?? 'Got it.'}
                        onAnswer={handleDifficultyAnswer}
                        onSkip={handleDifficultySkip}
                      />
                    ) : isCurrent && coachReaction ? (
                      <CoachMessageCard
                        key={coachReaction.id}
                        text={coachReaction.text}
                        showDisclaimer={coachReaction.isSuggestion}
                        onDismiss={() => setCoachReaction(null)}
                      />
                    ) : null
                  }
                />
              );
            }}
            onScroll={scrollHandler}
            onMomentumScrollEnd={onMomentumScrollEnd}
            scrollEnabled={!isListModeOpen && !isReordering}
            snapToInterval={SCREEN_HEIGHT}
            decelerationRate="fast"
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            pagingEnabled
            // NOTE: no per-second values here — the rest countdown ticks inside
            // WorkoutTimerPill only, so the pager never re-renders during rest.
            extraData={`${exerciseProgress.exerciseIndex}-${exerciseProgress.currentSet}-${exerciseProgress.totalSets}-${completedExerciseIndexes.join(',')}-${isListModeOpen}-${isResting}-${Object.values(sessionSetLog).reduce((acc, sets) => acc + sets.length, 0)}-${coachReaction ? coachReaction.id : 'x'}-${feelingAsked ? 1 : 0}-${difficultyAsked ? 1 : 0}-lw${Object.keys(lastWeekByExercise).length}-sd${stripDismissedForExercise ?? 'n'}`}
            removeClippedSubviews={false}
            maxToRenderPerBatch={3}
            windowSize={3}
            getItemLayout={(data, index) => ({
              length: SCREEN_HEIGHT,
              offset: SCREEN_HEIGHT * index,
              index,
            })}
          />

          {/* Segmented progress bar — Stories-style, top overlay */}
          <View style={[styles.segmentedBar, { top: Math.max(insets.top + 8, 16) }]} pointerEvents="none">
            {structuredExercises.map((_, i) => {
              const isDone = completedExerciseIndexes.includes(i);
              const isCur = i === exerciseProgress.exerciseIndex;
              const fill = isDone ? 1 : isCur
                ? Math.min(1, exerciseProgress.currentSet / Math.max(1, exerciseProgress.totalSets))
                : 0;
              return (
                <View key={i} style={styles.segBarTrack}>
                  <View style={[styles.segBarFill, { width: `${fill * 100}%` as any }]} />
                </View>
              );
            })}
          </View>

          {/* Dynamic timer pill — TOP-RIGHT, never over page content (the old
              bottom bar floated over the coach cards). Shows the set counter +
              time on the exercise; during rest it becomes the countdown ring.
              Tap = log the set / skip rest. Hidden while browsing other pages
              and once the workout is done. */}
          {!isWorkoutComplete &&
            exercises.length > 0 &&
            currentIndex === exerciseProgress.exerciseIndex &&
            !completedExerciseIndexSet.has(exerciseProgress.exerciseIndex) && (
              <View style={[styles.timerPillContainer, { top: Math.max(insets.top + 20, 54) }]}>
                <WorkoutTimerPill
                  isResting={isResting}
                  restEndTime={restEndTime}
                  restDuration={currentRestTime}
                  setNumber={exerciseProgress.currentSet}
                  totalSets={exerciseProgress.totalSets}
                  exerciseStartedAt={exerciseStartedAt}
                  canQuickLog={quickLogTarget.canQuickLog}
                  isLogging={isLoggingSet}
                  onQuickLog={() => handleLogSet(quickLogTarget.weight, quickLogTarget.reps, 'quick_tap')}
                  onOpenEditor={handleLogSetPress}
                  onSkipRest={handleSkipRest}
                  onExtendRest={handleExtendRest}
                />
              </View>
            )}

          {/* One-time coach-mark for the pill — logging is the player's whole
              job and the control is compact, so the first visit gets a plain-
              words pointer. Shows once ever (FirstVisitHint owns the flag).
              Gated on consent being resolved: the consent Modal covers the
              player on the very first workout, and mounting the hint behind
              it would burn its once-ever flag unseen. */}
          {liabilityAccepted === true &&
            !isWorkoutComplete &&
            exercises.length > 0 &&
            !isResting &&
            currentIndex === exerciseProgress.exerciseIndex &&
            !completedExerciseIndexSet.has(exerciseProgress.exerciseIndex) && (
              <View
                style={[styles.logHintContainer, { top: Math.max(insets.top + 20, 54) + 56 }]}
                pointerEvents="box-none"
              >
                <FirstVisitHint
                  appearance="light"
                  hintKey="workout_log"
                  text={'Tap "Log set" at the top right to save each set — long-press it to change weight or reps.'}
                />
              </View>
            )}

          {/* Read/edit view for a completed exercise's logged sets */}
          <EditSetsSheet
            visible={editSetsIndex !== null}
            exerciseName={
              editSetsIndex !== null
                ? formatExerciseName(structuredExercises[editSetsIndex]?.name) || 'Exercise'
                : ''
            }
            unit={userWeightUnit}
            isBodyweight={
              editSetsIndex !== null
                ? getEquipmentLoggingType(structuredExercises[editSetsIndex]?.equipment || 'body weight') === 'none'
                : false
            }
            sets={editSetsIndex !== null ? sessionSetLog[editSetsIndex] ?? [] : []}
            onClose={() => setEditSetsIndex(null)}
            onSaveSet={(setNumber, weight, reps) => {
              if (editSetsIndex !== null) {
                handleSaveEditedSet(editSetsIndex, setNumber, weight, reps);
              }
            }}
          />

          <BottomSheetModal
            ref={listModeSheetRef}
            index={0}
            snapPoints={listSheetSnapPoints}
            enablePanDownToClose
            onDismiss={() => setIsListModeOpen(false)}
            backgroundStyle={styles.listModeSheet}
            handleIndicatorStyle={styles.listSheetIndicator}
          >
            <BottomSheetView style={styles.listSheetInner}>
              <View style={styles.listModeHeader}>
                <Text style={styles.listModeTitle}>Today&apos;s Exercises</Text>
              </View>
              <DraggableFlatList
                data={listModeItems}
                keyExtractor={(item) => item.instanceKey}
                renderItem={renderListModeItem}
                onDragBegin={() => setIsReordering(true)}
                onDragEnd={handleListDragEnd}
                scrollEnabled
                activationDistance={10}
                contentContainerStyle={styles.draggableContentContainer}
              />
            </BottomSheetView>
          </BottomSheetModal>

          {/* Swap Modal — 2-step: reason → alternatives */}
          <Modal
            visible={isSwapModalOpen}
            animationType="slide"
            transparent
            onRequestClose={() => { setIsSwapModalOpen(false); setSwapReason(null); }}
          >
            <View style={styles.swapModalBackdrop}>
              <View style={styles.swapModalCard}>

                {/* Handle */}
                <View style={styles.swapHandle} />

                {/* Header */}
                <View style={styles.swapModalHeader}>
                  {swapReason ? (
                    <TouchableOpacity style={styles.swapBackBtn} onPress={() => setSwapReason(null)}>
                      <Ionicons name="chevron-back" size={20} color="#111" />
                    </TouchableOpacity>
                  ) : (
                    <View style={{ width: 32 }} />
                  )}
                  <Text style={styles.swapModalTitle}>
                    {swapReason ? 'Pick an alternative' : 'Why are you swapping?'}
                  </Text>
                  <TouchableOpacity onPress={() => { setIsSwapModalOpen(false); setSwapReason(null); }}>
                    <Ionicons name="close" size={22} color="#111" />
                  </TouchableOpacity>
                </View>

                {/* Step 1 — reason grid */}
                {!swapReason && (
                  <View style={styles.swapReasonList}>
                    {swapReasons.map((reason) => (
                      <TouchableOpacity
                        key={reason.key}
                        style={styles.swapReasonRow}
                        onPress={() => setSwapReason(reason.key)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.swapReasonIconWrap}>
                          <Ionicons name={reason.icon} size={18} color="#111" />
                        </View>
                        <Text style={styles.swapReasonLabel}>{reason.label}</Text>
                        <Ionicons name="chevron-forward" size={16} color="#BBB" />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Step 2 — alternatives list */}
                {swapReason && (
                  <View style={styles.swapAlternativesContainer}>
                    {/* Paywall swap-row treatment: outgoing exercise struck
                        through, blue swap icon pointing at the picks below. */}
                    <View style={styles.swapContextRow}>
                      <Text style={styles.swapContextOld} numberOfLines={1}>
                        {formatExerciseName(currentSwapTarget?.name)}
                      </Text>
                      <Ionicons name="swap-horizontal" size={15} color="#2E90FA" />
                      <Text style={styles.swapContextNew}>pick a replacement</Text>
                    </View>

                    {alternativesQuery.isLoading || alternativesQuery.isPending ? (
                      [0, 1, 2].map((index) => (
                        <Animated.View
                          key={`swap-skeleton-${index}`}
                          style={[styles.swapAlternativeRow, skeletonPulseStyle]}
                        >
                          <View style={styles.swapSkelThumb} />
                          <View style={{ flex: 1, gap: 8 }}>
                            <View style={styles.swapAlternativeSkeletonTitle} />
                            <View style={styles.swapAlternativeSkeletonMeta} />
                          </View>
                        </Animated.View>
                      ))
                    ) : (alternativesQuery.data ?? []).length === 0 ? (
                      <View style={styles.swapEmptyState}>
                        <Text style={styles.swapEmptyStateText}>
                          No alternatives found. Try a different reason or contact support.
                        </Text>
                      </View>
                    ) : (
                      (alternativesQuery.data ?? []).map((alternative) => (
                        <TouchableOpacity
                          key={`${exerciseProgress.exerciseIndex}-${alternative.id}`}
                          style={styles.swapAlternativeRow}
                          disabled={swapMutation.isPending}
                          onPress={() => swapMutation.mutate(alternative)}
                          activeOpacity={0.7}
                        >
                          {/* Thumbnail */}
                          {(() => {
                            const gifUrl = alternative.gif_path
                              ? getExerciseGifUrl(alternative.gif_path)
                              : null;
                            return gifUrl ? (
                              <Image
                                source={{ uri: gifUrl }}
                                style={styles.swapAltThumb}
                                contentFit="contain"
                              />
                            ) : (
                              <View style={[styles.swapAltThumb, styles.swapAltThumbEmpty]}>
                                <Ionicons name="barbell-outline" size={20} color="#CCC" />
                              </View>
                            );
                          })()}

                          {/* Name + muscle + equipment pill */}
                          <View style={{ flex: 1, gap: 4 }}>
                            <Text style={styles.swapAlternativeName} numberOfLines={2}>
                              {formatExerciseName(alternative.name)}
                            </Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <Text style={styles.swapAlternativeMeta}>
                                {alternative.target_muscle || alternative.body_part || 'General'}
                              </Text>
                              {alternative.equipment ? (
                                <View style={styles.swapEquipPill}>
                                  <Text style={styles.swapEquipPillText}>
                                    {(alternative as any).equipment_display || normalizeEquipment(alternative.equipment)}
                                  </Text>
                                </View>
                              ) : null}
                            </View>
                          </View>

                          <Ionicons name="chevron-forward" size={16} color="#AAAAAA" />
                        </TouchableOpacity>
                      ))
                    )}
                  </View>
                )}
              </View>
            </View>
          </Modal>

          {/* Swap success toast */}
          {swapToastName ? (
            <View style={styles.swapToast} pointerEvents="none">
              <Ionicons name="checkmark-circle" size={18} color="#FFF" />
              <Text style={styles.swapToastText} numberOfLines={1}>
                Swapped to {swapToastName}
              </Text>
            </View>
          ) : null}


          {/* Set Logger Bottom Sheet — dismissible: closing without logging is
              harmless now (nothing is half-committed until "Log" is tapped). */}
          <BottomSheet
            ref={restBottomSheetRef}
            index={-1}
            snapPoints={['60%', '85%']}
            enablePanDownToClose={true}
            backgroundStyle={styles.restSheetBackground}
            handleIndicatorStyle={styles.restSheetIndicator}
            onChange={(index) => {
              // Scroll to top when bottom sheet opens
              if (index >= 0) {
                setTimeout(() => {
                  restScrollViewRef.current?.scrollTo({ y: 0, animated: true });
                }, 100);
              }
            }}
          >
            <BottomSheetScrollView
              ref={restScrollViewRef}
              style={styles.restSheetContent}
              contentContainerStyle={styles.restSheetContentContainer}
            >
              {/* Header — exercise name so context survives the sheet covering
                  the page title, plus the live set counter. */}
              <View style={styles.restHeader}>
                <Text style={styles.restHeaderText} numberOfLines={1}>
                  {formatExerciseName(structuredExercises[exerciseProgress.exerciseIndex]?.name) || 'Log Set'}
                </Text>
                <Text style={styles.restHeaderCounter}>
                  Set {exerciseProgress.currentSet}/{exerciseProgress.totalSets}
                </Text>
              </View>

              {/* Inline keypad-based set logger with AI-prefilled values */}
              {(() => {
                const currentExercise = exercises[exerciseProgress.exerciseIndex];
                const equipmentType = currentExercise
                  ? getEquipmentLoggingType(currentExercise.equipment)
                  : 'none';
                const { min: minWeight, max: maxWeight } = getWeightRange(equipmentType);
                const weightStep = userWeightUnit === 'lbs' ? 2.5 : 1.25;

                return (
                  <InlineSetLogger
                    totalSets={exerciseProgress.totalSets}
                    currentSet={exerciseProgress.currentSet}
                    completedSets={exerciseProgress.setsCompleted}
                    recommendations={effectiveRecommendations}
                    equipmentType={equipmentType}
                    unit={userWeightUnit}
                    weightStep={weightStep}
                    minWeight={minWeight}
                    maxWeight={maxWeight}
                    plates={currentPlates}
                    barWeight={currentBarWeight}
                    onCompleteSet={(_setNum, weight, reps) => {
                      handleLogSet(weight, reps, 'editor');
                    }}
                    onAddSet={handleAddSet}
                    onEndExerciseEarly={
                      exerciseProgress.setsCompleted.length > 0 ? handleEndExerciseEarly : undefined
                    }
                  />
                );
              })()}
            </BottomSheetScrollView>
          </BottomSheet>

          {/* Bottom Sheet for Instructions */}
          <BottomSheet
            ref={bottomSheetRef}
            index={-1}
            snapPoints={['50%', '90%']}
            enablePanDownToClose={true}
            backgroundStyle={styles.bottomSheetBackground}
            handleIndicatorStyle={styles.bottomSheetIndicator}
          >
            <BottomSheetScrollView style={styles.bottomSheetContent}>
              {selectedExercise && (
                <>
                  <Text style={styles.bottomSheetTitle}>{formatExerciseName(selectedExercise.name)} Instructions</Text>
                  {selectedExercise.instructions.map((instruction, idx) => (
                    <View key={idx} style={styles.instructionItem}>
                      <Text style={styles.instructionNumber}>{idx + 1}</Text>
                      <Text style={styles.instructionText}>{instruction}</Text>
                    </View>
                  ))}
                </>
              )}
            </BottomSheetScrollView>
          </BottomSheet>

          {/* Rest-timer banner ad removed from the scroll UI — kept the
              workout-complete celebration banner only. */}

          {/* Workout Complete Screen — kept deliberately simple: a quick fade
              in, checkmark, and Finish. */}
          {isWorkoutComplete && (
            <View style={styles.workoutCompleteOverlay}>
              <Animated.View
                entering={FadeIn.duration(200)}
                style={styles.workoutCompleteContent}
              >
                <View style={styles.workoutCompleteIconWrap}>
                  <View style={styles.workoutCompleteIconCircle}>
                    <Ionicons name="checkmark" size={48} color="#FFFFFF" />
                  </View>
                </View>
                <Text style={styles.workoutCompleteTitle}>Workout Complete!</Text>
                <Text style={styles.workoutCompleteSubtitle}>Great job — all exercises done.</Text>
                {sessionPR && (
                  <View style={styles.workoutCompletePR}>
                    <View style={styles.workoutCompletePRRow}>
                      <View style={styles.workoutCompletePRBadge}>
                        <Text style={styles.workoutCompletePRBadgeText}>PR</Text>
                      </View>
                      <Text style={styles.workoutCompletePRText}>
                        {sessionPR.exercise} {sessionPR.value}
                      </Text>
                    </View>
                    <StatShareButton
                      label="Share PR"
                      tint="#2E90FA"
                      textColor="#1A1A1A"
                      stat={{
                        kind: 'pr',
                        value: sessionPR.value,
                        label: sessionPR.exercise,
                        subtitle: 'New personal best!',
                      }}
                    />
                  </View>
                )}
                {tier !== 'premium' && (
                  <AdBanner
                    style={styles.workoutCompleteAd}
                    size={BannerAdSize.MEDIUM_RECTANGLE}
                  />
                )}
                <TouchableOpacity
                  style={styles.workoutCompleteButton}
                  onPress={() => {
                    // No interstitial on Finish — the summary already hosts a
                    // banner. Punishing the completion moment hurts retention.
                    if (typeof onComplete === 'function') {
                      // onComplete owns navigation (workout/index replaces to
                      // home). Popping after it here landed on whatever sat
                      // below the player — including the pre-auth welcome
                      // screen during the onboarding first workout.
                      try { onComplete(); } catch { }
                    } else {
                      exitToPreviousOrHome();
                    }
                  }}
                >
                  <Text style={styles.workoutCompleteButtonText}>Finish</Text>
                </TouchableOpacity>
              </Animated.View>
            </View>
          )}
        </SafeAreaView>
        {/* First-ever-workout agreement — native Modal, so it covers the whole
            player until the user explicitly accepts (or backs out). */}
        <LiabilityConsentSheet
          visible={liabilityAccepted === false}
          onAccept={handleConsentAccept}
          onDecline={handleConsentDecline}
        />
        <QuotaLimitSheet error={quotaError} onClose={() => setQuotaError(null)} feature="exercise_swap" />
      </BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  loadingText: {
    color: '#000000',
    marginTop: 12,
    fontSize: 16,
    fontFamily: 'Montserrat_400Regular',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  errorText: {
    color: '#000000',
    fontSize: 18,
    fontFamily: 'Montserrat_600SemiBold',
    marginTop: 12,
  },
  errorSubtext: {
    color: '#666666',
    fontSize: 14,
    fontFamily: 'Montserrat_400Regular',
    marginTop: 4,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  errorBackButton: {
    marginTop: 20,
    backgroundColor: '#111111',
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  errorBackButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: 'Montserrat_700Bold',
  },
  exerciseContainer: {
    height: SCREEN_HEIGHT,
    width: SCREEN_WIDTH,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  imageContainer: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    marginTop: -120,
  },
  exerciseImage: {
    width: '100%',
    height: '100%',
    maxWidth: SCREEN_WIDTH,
    maxHeight: SCREEN_HEIGHT,
  },
  // Top bar styles
  topBar: {
    position: 'absolute',
    top: 60,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 10,
  },
  backButton: {
    // Transparent background with no styling
  },
  topBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  topBarIconButton: {
    width: 36,
    height: 36,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  listModeSheet: {
    backgroundColor: '#FFF',
    borderRadius: 20,
  },
  listSheetInner: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
  },
  listSheetIndicator: {
    backgroundColor: '#CBCBCB',
    width: 38,
  },
  listModeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  listModeTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#121212',
  },
  currentBadge: {
    color: '#1A6FE0',
    fontWeight: '700',
    fontSize: 11,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E8E8E8',
    backgroundColor: '#FFF',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
  },
  listRowLocked: {
    backgroundColor: '#F3F3F3',
    borderColor: '#E2E2E2',
    opacity: 0.8,
  },
  listRowActive: {
    backgroundColor: '#F2F7FF',
    borderColor: '#CDE0FF',
  },
  listRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  listRowTextWrap: {
    flex: 1,
  },
  listRowText: {
    color: '#1A1A1A',
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  listRowTextLocked: {
    color: '#868686',
  },
  listRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  equipmentPill: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: '#ECECEC',
    color: '#5E5E5E',
    fontSize: 11,
    fontWeight: '600',
  },
  draggableContentContainer: {
    paddingBottom: 8,
  },
  swapModalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  swapModalCard: {
    backgroundColor: '#FFF',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    minHeight: '55%',
  },
  swapModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  swapModalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
  },
  // Step 1 — reason grid
  swapHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 4,
    alignSelf: 'center',
    marginBottom: 12,
  },
  swapBackBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F3F3F3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swapReasonList: {
    gap: 12,
    marginTop: 8,
    marginBottom: 8,
  },
  swapReasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ECECEC',
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
  },
  swapReasonIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: '#F2F2F2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swapReasonLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: '#111',
    letterSpacing: 0.1,
  },
  // Step 2 — alternatives
  swapAlternativesContainer: {
    gap: 12,
  },
  // Paywall swap-row: blue-tinted hairline row, old exercise struck through.
  swapContextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(46,144,250,0.35)',
    backgroundColor: 'rgba(46,144,250,0.08)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 2,
  },
  swapContextOld: {
    flexShrink: 1,
    fontSize: 13,
    fontFamily: 'Montserrat_500Medium',
    color: '#9AA1AB',
    textDecorationLine: 'line-through',
  },
  swapContextNew: {
    fontSize: 13,
    fontFamily: 'Montserrat_600SemiBold',
    color: '#333',
  },
  swapAlternativeRow: {
    borderWidth: 1,
    borderColor: '#ECECEC',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#FAFAFA',
  },
  swapAltThumb: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#F0F0F0',
  },
  swapAltThumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  swapEquipPill: {
    backgroundColor: '#EFEFEF',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  swapEquipPillText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#555',
  },
  swapAlternativeName: {
    color: '#111',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
  },
  swapAlternativeMeta: {
    color: '#6E6E6E',
    fontSize: 12,
  },
  swapSkelThumb: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#E5E5E5',
  },
  swapAlternativeSkeletonTitle: {
    height: 14,
    width: '62%',
    borderRadius: 8,
    backgroundColor: '#DFDFDF',
  },
  swapAlternativeSkeletonMeta: {
    height: 11,
    width: '44%',
    borderRadius: 8,
    backgroundColor: '#E8E8E8',
  },
  swapEmptyState: {
    borderWidth: 1,
    borderColor: '#EAEAEA',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#FCFCFC',
    gap: 12,
  },
  swapEmptyStateText: {
    color: '#575757',
    fontSize: 13,
    lineHeight: 18,
  },
  swapFallbackButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#111',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  swapFallbackButtonText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: '700',
  },
  // Toast
  swapToast: {
    position: 'absolute',
    bottom: 110,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#111',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 12,
    zIndex: 100,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 8,
  },
  swapToastText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '600',
    maxWidth: 220,
  },
  goToCurrentPillContainer: {
    position: 'absolute',
    bottom: 260,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 15,
  },
  goToCurrentPill: {
    backgroundColor: '#EDEDED',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  goToCurrentPillText: {
    color: '#111111',
    fontSize: 13,
    fontWeight: '700',
  },
  // Dynamic timer pill — top-right, below the Stories progress bar and level
  // with the page's back-button row (top set inline from safe-area insets).
  timerPillContainer: {
    position: 'absolute',
    right: 16,
    zIndex: 30,
    alignItems: 'flex-end',
  },
  // First-visit "how to log" banner — sits directly under the pill (top set
  // inline from the pill's own offset + its 46pt height).
  logHintContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 29,
  },
  // Completed-page treatment: dimmed GIF + overlay with logged sets
  imageContainerCompleted: {
    opacity: 0.35,
  },
  completedOverlay: {
    position: 'absolute',
    top: '30%',
    left: 24,
    right: 24,
    alignItems: 'center',
    gap: 10,
    zIndex: 12,
  },
  completedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#DBE7F5',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  completedBadgeText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#111111',
  },
  completedSummaryText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  editSetsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#EDEDED',
    borderRadius: 999,
    minHeight: 44,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  editSetsButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111111',
  },
  // Set control center (progress + button left aligned)
  setControlCenter: {
    position: 'absolute',
    bottom: 200,
    left: 20,
    right: 20,
    alignItems: 'flex-start',
    zIndex: 10,
  },
  setProgress: {
    alignItems: 'center',
    marginBottom: 16,
  },
  setProgressText: {
    color: '#000',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
    textAlign: 'left',
  },
  // Animated Set Counter Styles
  setCounterContainer: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  setCounterBackground: {
    flexDirection: 'row',
    backgroundColor: '#F0F0F0',
    borderRadius: 20,
    padding: 4,
    marginBottom: 8,
  },
  setCounterDot: {
    width: 12,
    height: 12,
    borderRadius: 8,
    backgroundColor: '#E0E0E0',
    marginHorizontal: 2,
  },
  setCounterDotCompleted: {
    backgroundColor: '#2E90FA',
    transform: [{ scale: 1.2 }],
  },
  setCounterDotCurrent: {
    backgroundColor: '#2E90FA',
    transform: [{ scale: 1.3 }],
    shadowColor: '#2E90FA',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 4,
  },
  setCounterText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'left',
  },
  repsAndButtonContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  repsText: {
    color: '#666',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'left',
    flex: 1,
  },
  doneSetButtonCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#2E90FA',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#2E90FA',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  progressDots: {
    flexDirection: 'row',
    gap: 4,
  },
  progressDot: {
    width: 6,
    height: 6,
    borderRadius: 4,
    backgroundColor: '#E0E0E0',
  },
  progressDotCompleted: {
    backgroundColor: '#2E90FA',
  },
  doneSetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2E90FA',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    gap: 8,
    shadowColor: '#2E90FA',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  doneSetButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  // Bottom exercise info (no card background)
  exerciseInfo: {
    position: 'absolute',
    bottom: 120,
    left: 20,
    right: 20,
    zIndex: 5,
  },
  // Voice captions sit just above the exerciseInfo block on each page so
  // they're tied to the GIF, not floating across the whole screen.
  voiceCaptionsAnchor: {
    position: 'absolute',
    bottom: 260,
    left: 20,
    right: 20,
    zIndex: 6,
  },
  indexIndicatorAboveName: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  indexTextAboveName: {
    color: '#000',
    fontSize: 12,
    fontWeight: '600',
  },
  exerciseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerRightContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  exerciseName: {
    color: '#000',
    fontSize: 28,
    fontWeight: 'bold',
    textShadowColor: 'rgba(255, 255, 255, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
    flex: 1,
  },
  instructionsIconButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderRadius: 20,
    padding: 4,
    marginLeft: 12,
  },
  pillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 2,
  },
  metaPill: {
    backgroundColor: '#F3F5F9',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  metaPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111',
  },
  metaPillLast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaPillAmber: {
    backgroundColor: 'rgba(46, 144, 250, 0.14)',
  },
  injuryNoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(46, 144, 250, 0.10)',
  },
  injuryNoteText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: '#1D6FD1',
  },
  pillIconButton: {
    backgroundColor: '#F3F5F9',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillIconButtonLive: {
    backgroundColor: '#2E90FA',
  },
  pillIconButtonConnecting: {
    backgroundColor: 'rgba(46, 144, 250, 0.55)',
  },
  pillIconButtonThinking: {
    backgroundColor: '#2E90FA',
  },
  metaPillTextAmber: {
    color: '#1A6FE0',
  },
  segmentedBar: {
    position: 'absolute',
    top: 8,
    left: 16,
    right: 16,
    flexDirection: 'row',
    gap: 4,
    zIndex: 20,
  },
  segBarTrack: {
    flex: 1,
    height: 3,
    borderRadius: 4,
    backgroundColor: 'rgba(180,180,180,0.45)',
    overflow: 'hidden',
  },
  segBarFill: {
    height: 3,
    borderRadius: 4,
    backgroundColor: '#2E90FA',
  },
  bottomSheetBackground: {
    backgroundColor: '#fff',
  },
  bottomSheetIndicator: {
    backgroundColor: '#2E90FA',
  },
  bottomSheetContent: {
    padding: 20,
  },
  bottomSheetTitle: {
    color: '#000',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  instructionItem: {
    flexDirection: 'row',
    marginBottom: 16,
    alignItems: 'flex-start',
  },
  instructionNumber: {
    color: '#2E90FA',
    fontSize: 16,
    fontWeight: 'bold',
    marginRight: 10,
    minWidth: 25,
  },
  instructionText: {
    color: '#000',
    fontSize: 16,
    lineHeight: 22,
    flex: 1,
  },
  structuredInfo: {
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  structuredRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  structuredLabel: {
    color: '#666',
    fontSize: 14,
    fontWeight: '600',
  },
  structuredValue: {
    color: '#2E90FA',
    fontSize: 14,
    fontWeight: 'bold',
  },
  // Rest bottom sheet styles
  restSheetBackground: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  restSheetIndicator: {
    backgroundColor: '#E0E0E0',
    width: 40,
    height: 4,
  },
  restSheetContent: {
    flex: 1,
  },
  restSheetContentContainer: {
    padding: 16,
    paddingBottom: 24,
  },
  restHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  restHeaderText: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: '#0F172A',
  },
  restHeaderCounter: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2E90FA',
    fontVariant: ['tabular-nums'],
    marginLeft: 8,
  },
  setsTableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#EFEFEF',
    marginBottom: 8,
  },
  setNumColHeader: { width: 32, alignItems: 'center' },
  prevColHeader: { flex: 1, alignItems: 'center' },
  weightColHeader: { width: 92, alignItems: 'center' },
  repsColHeader: { width: 66, alignItems: 'center' },
  checkColHeader: { width: 44 },
  setColHeaderText: { fontSize: 11, fontWeight: '600', color: '#AAAAAA' },
  setRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 12,
    marginBottom: 8,
  },
  setRowCompleted: { backgroundColor: '#F8F8F8' },
  setRowActive: {
    backgroundColor: '#F0F7FF',
    borderWidth: 1.5,
    borderColor: '#CCE0FF',
    paddingVertical: 8,
  },
  setRowFuture: { opacity: 0.45 },
  setNumColCell: { width: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 },
  prevColCell: { flex: 1, alignItems: 'center', paddingHorizontal: 2 },
  weightColCell: { width: 92, alignItems: 'center' },
  repsColCell: { width: 66, alignItems: 'center' },
  checkColCell: { width: 44, alignItems: 'center' },
  setNumText: { fontSize: 15, fontWeight: '700', color: '#111' },
  setNumTextDone: { fontSize: 13, fontWeight: '600', color: '#888', marginLeft: 2 },
  setNumTextDimmed: { fontSize: 14, fontWeight: '600', color: '#999' },
  ghostCellText: { fontSize: 12, color: '#AAAAAA', fontWeight: '500', textAlign: 'center' },
  ghostCellTextDimmed: { fontSize: 12, color: '#CCCCCC', fontWeight: '500', textAlign: 'center' },
  loggedValueText: { fontSize: 14, fontWeight: '600', color: '#555', textAlign: 'center' },
  futureCellText: { fontSize: 13, color: '#BBBBBB', fontWeight: '500', textAlign: 'center' },
  inputPill: {
    flexDirection: 'row',
    alignItems: 'baseline',
    backgroundColor: '#FFF',
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#BDD4FF',
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 2,
    justifyContent: 'center',
    minWidth: 60,
  },
  inputPillValue: { fontSize: 16, fontWeight: '700', color: '#000' },
  inputPillGhost: { fontSize: 15, fontWeight: '600', color: '#AAAAAA' },
  inputPillUnit: { fontSize: 10, color: '#AAAAAA', fontWeight: '500', alignSelf: 'flex-end', marginBottom: 1 },
  completeSetBtn: {
    width: 38,
    height: 38,
    borderRadius: 20,
    backgroundColor: '#2E90FA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactTimerText: {
    color: '#000',
    fontSize: 40,
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  weightSection: {
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
    textAlign: 'center',
  },
  weightDisplayCompact: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginBottom: 4,
  },
  weightValueCompact: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#000',
  },
  weightUnitCompact: {
    fontSize: 16,
    fontWeight: '600',
    color: '#666',
    marginLeft: 6,
  },
  // Slider styles
  sliderContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
    paddingHorizontal: 20,
  },
  horizontalSlider: {
    width: '100%',
    height: 40,
  },
  sliderMarkers: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 8,
  },
  markerText: {
    fontSize: 12,
    color: '#999',
    fontWeight: '500',
  },
  markerTextSmall: {
    fontSize: 11,
    color: '#999',
    fontWeight: '500',
  },
  weightValueCompactSmall: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#000',
  },
  weightUnitCompactSmall: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginLeft: 6,
  },
  continueButtonCompact: {
    backgroundColor: '#2E90FA',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  continueButtonTextCompact: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  // Bodyweight exercise styles
  bodyweightText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#000',
    textAlign: 'center',
    marginTop: 12,
  },
  bodyweightSubtext: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  // Barbell plate system styles
  barWeightNote: {
    fontSize: 10,
    color: '#999',
    textAlign: 'center',
    marginTop: -4,
    marginBottom: 4,
  },
  wheelContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  balanceToggleContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#F5F5F5',
    borderRadius: 8,
    marginVertical: 8,
  },
  balanceToggleLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#000',
  },
  platesGridContainer: {
    gap: 16,
    marginTop: 8,
    alignItems: 'center',
  },
  platesRow: {
    flexDirection: 'row',
    gap: 16,
    width: '100%',
    justifyContent: 'center',
  },
  plateItem: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 60,
    maxHeight: 60,
    minWidth: 0,
    maxWidth: '50%',
  },
  plateButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
  },
  plateButtonInline: {
    width: 28,
    height: 28,
    borderRadius: 16,
    backgroundColor: '#FFF',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#2E90FA',
    flexShrink: 0,
  },
  plateWeightText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#000',
    textAlign: 'center',
    width: 50,
    flexShrink: 0,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  workoutCompleteOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  workoutCompleteContent: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  workoutCompleteIconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  workoutCompleteIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 999,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  workoutCompleteTitle: {
    fontSize: 28,
    fontFamily: 'Montserrat_700Bold',
    color: '#000000',
    textAlign: 'center',
    marginBottom: 12,
  },
  workoutCompleteSubtitle: {
    fontSize: 16,
    fontFamily: 'Montserrat_400Regular',
    color: '#555555',
    textAlign: 'center',
    marginBottom: 24,
  },
  // Blue-tinted PR celebration card (paywall PR-badge treatment; the old
  // gold tint violated the blue-only accent rule).
  workoutCompletePR: {
    alignItems: 'center',
    gap: 12,
    marginBottom: 24,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 16,
    backgroundColor: 'rgba(46,144,250,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(46,144,250,0.35)',
  },
  workoutCompletePRRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  workoutCompletePRBadge: {
    backgroundColor: '#2E90FA',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2.5,
  },
  workoutCompletePRBadgeText: {
    fontFamily: 'Montserrat_700Bold',
    fontSize: 10,
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  workoutCompletePRText: {
    fontSize: 14,
    fontFamily: 'Montserrat_600SemiBold',
    color: '#1A1A1A',
  },
  workoutCompleteAd: {
    marginBottom: 24,
  },
  workoutCompleteButton: {
    backgroundColor: '#000000',
    paddingVertical: 16,
    paddingHorizontal: 56,
    borderRadius: 999,
  },
  workoutCompleteButtonText: {
    fontSize: 16,
    fontFamily: 'Montserrat_700Bold',
    color: '#FFFFFF',
  },
});

export default ExerciseTikTokScroll;