// app/(tabs)/index.tsx
/**
 * Home Tab - Today's Workout Display
 * 
 * Route: /(tabs)/index
 * Function: Main dashboard showing today's workout from the user's personalized plan
 * 
 * Features:
 * - Displays current day, split, and exercises
 * - Shows workout progress and consistency calendar
 * - Allows starting workouts and logging rest days
 * - Handles workout plan updates and replacements
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { clearActiveWorkoutSession, getActiveWorkoutSession, wasWorkoutCompletedToday } from '../../utils/storage';

import AdBanner from '../../components/AdBanner';
import ConsistencyCalendar from '../../components/ConsistencyCalendar';
import GlassIconButton from '../../components/ui/GlassIconButton';
import StatChip from '../../components/ui/StatChip';
import CoachCheckinCard from '../../components/CoachCheckinCard';
import Week1ChecklistCard from '../../components/Week1ChecklistCard';
import HomeMetricsRow from '../../components/HomeMetricsRow';
import ExerciseSearchSheet from '../../components/ExerciseSearchSheet';
import { toast } from '../../components/ui/Toast';
import { TAB_BAR_CLEARANCE } from '../../constants/layout';
import { getThemeColors } from '../../constants/theme';
import { useFunnelFailsafe } from '../../hooks/useFunnelFailsafe';
import { useTheme } from '../../context/ThemeContext';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { logRestDay, shouldAutoLogRestDay } from '../../src/services/ProgressService';
import { WorkoutService } from '../../src/services/WorkoutService';
import { WorkoutType } from '../../types/workout';
import { normalizeExercises } from '../../utils/exerciseNormalizer';
import { getExerciseGifUrl } from '../../utils/exerciseGifs';
import { Image as ExpoImage } from 'expo-image';
import { posthog } from '../../src/config/posthog';
import { getUserProfile } from '../../utils/userProfile';
import { resolveFirstName } from '../../utils/nameUtils';

// Interface for calendar date
interface CalendarDate {
  date: Date;
  dayName: string;
  dayNumber: string;
  isToday: boolean;
  isSelected: boolean;
}

// Helper function for robust rest day detection (pure — shared by the
// selected-day render and the next-workout scan below).
const detectRestDay = (workoutData: any, dayOfWeek: string): boolean => {
  // If no workout data exists for this day
  if (!workoutData) return true;

  // If split name indicates rest day
  if (workoutData.splitName?.toLowerCase().includes('rest')) return true;

  // If no exercises or empty exercises array
  if (!workoutData.exercises || workoutData.exercises.length === 0) return true;

  // If estimated time is 0 or very low (likely a rest day)
  if (workoutData.estimatedTime <= 5) return true;

  return false;
};

/**
 * Next scheduled training day strictly after today. The rest-day CTA and
 * the week-1 checklist route through this so "do a workout" can never open
 * the player with an empty exercise list on a rest day. Null-safe: the
 * schedule loads from a separate query than the rest-day resolution and can
 * legitimately still be null while the rest card renders.
 */
const findNextWorkoutDay = (
  weeklySchedule: Record<string, any> | null
): { dayOfWeek: string; workout: any } | null => {
  if (!weeklySchedule) return null;
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayIdx = new Date().getDay();
  for (let offset = 1; offset <= 7; offset++) {
    const dayName = dayNames[(todayIdx + offset) % 7];
    const workoutData = weeklySchedule[dayName];
    if (workoutData && !detectRestDay(workoutData, dayName)) {
      return { dayOfWeek: dayName, workout: workoutData };
    }
  }
  return null;
};

// Helper functions
const getWeekDates = (): CalendarDate[] => {
  const today = new Date();
  const dates: CalendarDate[] = [];

  for (let i = -3; i <= 3; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    dates.push({
      date,
      dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
      dayNumber: date.getDate().toString(),
      isToday: i === 0,
      isSelected: i === 0,
    });
  }

  return dates;
};

const isToday = (date: Date): boolean => {
  const today = new Date();
  return date.toDateString() === today.toDateString();
};

// Skeleton primitives — opacity pulse, no layout-affecting animation.
function SkeletonBlock({
  width,
  height,
  radius = 8,
  pulse,
  isDark,
  style,
}: {
  width: number | string;
  height: number;
  radius?: number;
  pulse: Animated.Value;
  isDark: boolean;
  style?: any;
}) {
  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          borderRadius: radius,
          backgroundColor: isDark ? '#1F1F1F' : '#ECECEC',
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }),
        },
        style,
      ]}
    />
  );
}

function HomeSkeleton({ isDark, insetsTop }: { isDark: boolean; insetsTop: number }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={{ paddingTop: insetsTop, paddingHorizontal: 20 }}>
      {/* Header skeleton */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 4, paddingBottom: 16 }}>
        <View style={{ flex: 1 }}>
          <SkeletonBlock width={80} height={36} radius={8} pulse={pulse} isDark={isDark} style={{ marginBottom: 8 }} />
          <SkeletonBlock width={90} height={12} radius={4} pulse={pulse} isDark={isDark} style={{ marginBottom: 8 }} />
          <SkeletonBlock width={140} height={24} radius={6} pulse={pulse} isDark={isDark} />
        </View>
        <SkeletonBlock width={40} height={40} radius={10} pulse={pulse} isDark={isDark} />
      </View>

      {/* Calendar strip skeleton */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <SkeletonBlock key={i} width={40} height={52} radius={12} pulse={pulse} isDark={isDark} />
        ))}
      </View>

      {/* Workout card skeleton */}
      <View
        style={{
          borderRadius: 20,
          backgroundColor: isDark ? '#1A1A1A' : '#FAFAFA',
          padding: 16,
          marginBottom: 12,
        }}
      >
        <SkeletonBlock width={180} height={22} radius={6} pulse={pulse} isDark={isDark} style={{ marginBottom: 12 }} />
        <SkeletonBlock width={120} height={20} radius={999} pulse={pulse} isDark={isDark} style={{ marginBottom: 16 }} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginBottom: 16 }}>
          <View style={{ alignItems: 'center', flex: 1 }}>
            <SkeletonBlock width={36} height={26} radius={6} pulse={pulse} isDark={isDark} />
            <SkeletonBlock width={60} height={10} radius={3} pulse={pulse} isDark={isDark} style={{ marginTop: 8 }} />
          </View>
          <View style={{ alignItems: 'center', flex: 1 }}>
            <SkeletonBlock width={36} height={26} radius={6} pulse={pulse} isDark={isDark} />
            <SkeletonBlock width={60} height={10} radius={3} pulse={pulse} isDark={isDark} style={{ marginTop: 8 }} />
          </View>
        </View>
        <SkeletonBlock width={'100%'} height={44} radius={20} pulse={pulse} isDark={isDark} />
      </View>

      {/* Metrics row skeleton */}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <SkeletonBlock width={'48%'} height={132} radius={14} pulse={pulse} isDark={isDark} />
        <SkeletonBlock width={'48%'} height={132} radius={14} pulse={pulse} isDark={isDark} />
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { session, loading: authLoading } = useRequireAuth();

  // One cached funnel re-check per focus (replaces the two copy-pasted
  // resolveGuardedRoute blocks that each cost 3 queries + a RevenueCat sync).
  useFunnelFailsafe({ session, authLoading });

  const [todayWorkout, setTodayWorkout] = useState<any>(null);
  const [selectedWorkout, setSelectedWorkout] = useState<any>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [userId, setUserId] = useState('');
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [calendarDates, setCalendarDates] = useState<CalendarDate[]>(getWeekDates());
  const [showGoToToday, setShowGoToToday] = useState(false);
  const [weeklySchedule, setWeeklySchedule] = useState<any>(null);
  const [aiQuestion, setAiQuestion] = useState('');
  const [isReplacementWorkout, setIsReplacementWorkout] = useState(false);
  const [showWorkoutPreview, setShowWorkoutPreview] = useState(false);
  const [activeSession, setActiveSession] = useState<any>(null); // Chat/saved workout session
  const [mainPlanSession, setMainPlanSession] = useState<any>(null); // Main plan workout session
  // True when today's main-plan workout was already finished — CTA becomes "Re-do Workout".
  const [mainWorkoutDoneToday, setMainWorkoutDoneToday] = useState(false);
  const [userFirstName, setUserFirstName] = useState<string>('');
  const [exerciseSearchOpen, setExerciseSearchOpen] = useState(false);

  const scrollViewRef = useRef<ScrollView>(null);
  const aiInputRef = useRef<TextInput>(null);

  // Load profile for personalized greeting. Treat the placeholder "User"
  // string written by saveUserProfile as "no name resolved" and fall back
  // to OAuth user_metadata before giving up. Defined as a callback so it can
  // re-run on focus — otherwise editing the name in Settings wouldn't refresh
  // the home greeting until the next app launch.
  const loadUserFirstName = useCallback(async () => {
    if (!session) return;
    const { profile } = await getUserProfile(session.user.id);
    setUserFirstName(resolveFirstName(profile?.name, session.user.user_metadata));
  }, [session]);

  useEffect(() => {
    if (!authLoading && session) {
      // Rest-day auto-log needs the RESOLVED today state — reading component
      // state inside checkAndLogRestDay was a stale closure (null on first
      // mount), so rest days silently never got logged until a re-focus.
      void (async () => {
        const isRestDayToday = await loadTodaysWorkout();
        if (isRestDayToday != null) await checkAndLogRestDay(isRestDayToday);
      })();
      // Load active sessions separately by type
      loadActiveSessions();
      loadUserFirstName();
    }
  }, [authLoading, session, loadUserFirstName]);

  // Reload when tab comes into focus (e.g., after editing in chat)
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const isRestDayToday = await loadTodaysWorkout();
        if (isRestDayToday != null) await checkAndLogRestDay(isRestDayToday);
      })();
      loadActiveSessions();
      // Refresh greeting name in case it was changed in Settings.
      loadUserFirstName();
    }, [session, loadUserFirstName])
  );

  /**
   * Load active sessions, separating main plan from chat/saved workouts
   * Checks all workout types and organizes them by priority
   */
  const loadActiveSessions = async () => {
    const sessions: any[] = [];

    // Check all possible workout types
    for (const type of ['main_plan', 'extra_workout', 'saved_workout', 'replacement_workout'] as WorkoutType[]) {
      const session = await getActiveWorkoutSession(type);
      if (session) {
        // Augment session with workoutType for easier discrimination
        sessions.push({
          ...session,
          workoutType: type
        });
      }
    }

    // Separate by priority: main_plan sessions vs others
    const mainSession = sessions.find(s => s.workoutType === 'main_plan') || null;
    const otherSession = sessions.find(s => s.workoutType !== 'main_plan') || null;

    setMainPlanSession(mainSession);
    setActiveSession(otherSession);
    setMainWorkoutDoneToday(await wasWorkoutCompletedToday('main_plan'));

    console.log('Active sessions loaded:', {
      mainPlanSession: mainSession?.workoutName || 'none',
      otherSession: otherSession?.workoutName || 'none',
      totalSessions: sessions.length
    });
  };


  // Check and auto-log rest day if needed. Takes the resolved rest-day flag
  // as a parameter — never read it from component state here (stale closure).
  const checkAndLogRestDay = async (isRestDayToday: boolean) => {
    if (!session || !isRestDayToday) return;

    try {
      const today = new Date();
      const { shouldLog, error } = await shouldAutoLogRestDay(session.user.id, today);

      if (error) {
        console.error('Error checking rest day status:', error);
        return;
      }

      if (shouldLog) {
        await logRestDay(session.user.id, today);
        posthog.capture('rest_day_logged', { method: 'auto' });
        console.log('Rest day auto-logged for consistency tracking');
      }
    } catch (error) {
      console.error('Error auto-logging rest day:', error);
    }
  };

  // Update selected workout when date changes
  useEffect(() => {
    if (weeklySchedule) {
      loadWorkoutForDate(selectedDate);
    }
  }, [selectedDate, weeklySchedule]);

  // The next training day after today — derived once per schedule change and
  // shared by the rest-day CTA render and its tap handler, so they can never
  // disagree about which workout "Train today" starts.
  const nextWorkoutDay = useMemo(() => findNextWorkoutDay(weeklySchedule), [weeklySchedule]);

  // Load workout for a specific date
  const loadWorkoutForDate = async (date: Date) => {
    if (!weeklySchedule) return;

    const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const workoutData = weeklySchedule[dayOfWeek];

    // ROBUST REST DAY DETECTION
    const isRestDay = detectRestDay(workoutData, dayOfWeek);

    if (isRestDay) {
      console.log(`${dayOfWeek} is a rest day`);
      setSelectedWorkout({
        dayOfWeek,
        splitName: 'Rest Day',
        exercises: [],
        exercises_structured: [],
        estimatedTime: 0,
        isRestDay: true,
      });
      setIsReplacementWorkout(false);
    } else {
      console.log(`${dayOfWeek} is a workout day with`, workoutData.exercises?.length, 'exercises');
      setSelectedWorkout({
        dayOfWeek,
        splitName: workoutData.splitName,
        exercises: workoutData.exercises,
        exercises_structured: normalizeExercises(workoutData),
        estimatedTime: workoutData.estimatedTime,
        isRestDay: false,
      });
      setIsReplacementWorkout(workoutData.isReplacement || false);
    }
  };

  /**
   * Load today's workout - DB-FIRST VERSION
   * Uses WorkoutService.resolveToday() - single source of truth
   *
   * Returns whether today resolved to a rest day (null when there is no
   * plan / an error occurred) so callers can chain rest-day auto-logging
   * without reading component state that hasn't committed yet.
   */
  const loadTodaysWorkout = async (): Promise<boolean | null> => {
    if (!session) return null;

    try {
      setDataLoading(true);

      setUserId(session.user.id);

      // Get today's workout from WorkoutService (checks replacements, then plan, then rest)
      const todayState = await WorkoutService.resolveToday(session.user.id);

      if (todayState.status === 'error') {
        console.error('Error loading workout:', todayState.error);
        return null;
      }

      if (todayState.status === 'no_plan') {
        console.log('No active workout plan');
        setTodayWorkout(null);
        setSelectedWorkout(null);
        return null;
      }

      // Get active plan for weekly schedule
      const activePlan = await WorkoutService.getActivePlan(session.user.id);
      if (activePlan?.schedule) {
        // Build weekly schedule object
        const schedule: any = {};
        activePlan.schedule.forEach((day: any) => {
          schedule[day.day_of_week] = {
            splitName: day.split_day_name,
            exercises: day.exercises || [],
            exercises_structured: normalizeExercises(day),
            estimatedTime: day.estimated_time || 0,
          };
        });
        setWeeklySchedule(schedule);
      }

      // Set today's workout
      if (todayState.status === 'rest') {
        setTodayWorkout({
          isRestDay: true,
          dayOfWeek: todayState.dayOfWeek,
        });
        setSelectedWorkout({
          dayOfWeek: todayState.dayOfWeek,
          splitName: 'Rest Day',
          exercises: [],
          exercises_structured: [],
          estimatedTime: 0,
          isRestDay: true,
        });
        setIsReplacementWorkout(false);
      } else if (todayState.workout) {
        setTodayWorkout(todayState.workout);
        setSelectedWorkout({
          dayOfWeek: todayState.dayOfWeek,
          splitName: todayState.workout.splitName,
          exercises: todayState.workout.exercises,
          exercises_structured: normalizeExercises(todayState.workout),
          estimatedTime: todayState.workout.estimatedTime,
          isRestDay: false,
        });
        setIsReplacementWorkout(todayState.isReplacement);
      }

      return todayState.status === 'rest';
    } catch (error) {
      console.error('Error loading today\'s workout:', error);
      return null;
    } finally {
      setDataLoading(false);
    }
  };

  /**
   * Single builder for the /workout launch params — every main-plan start
   * (today's workout, resumed session, moved-up rest-day workout) goes
   * through here so the param contract can't drift between call sites.
   */
  const launchMainPlanWorkout = (
    workout: { splitName: string; exercises?: any[]; exercises_structured?: any[]; estimatedTime?: number },
    opts?: { sessionId?: string }
  ) => {
    // Use structured exercises if available, otherwise fall back to exercise names
    const structuredExercises = workout.exercises_structured || [];
    const exerciseNames = structuredExercises.length > 0
      ? structuredExercises.map((ex: any) => ex.name)
      : (workout.exercises || []).map((exercise: any) =>
        typeof exercise === 'string' ? exercise : exercise.name
      );

    router.push({
      pathname: '/workout',
      params: {
        exercises: JSON.stringify(exerciseNames),
        exerciseStructure: JSON.stringify(structuredExercises),
        exerciseNames: JSON.stringify(exerciseNames),
        workoutName: workout.splitName,
        estimatedTime: String(workout.estimatedTime || 0),
        difficulty: 'personalized',
        workoutType: 'main_plan',
        sessionId: opts?.sessionId,
      }
    });
  };

  /**
   * Pull the next scheduled workout forward and start it today. Training a
   * day early beats not training — the plan's day labels are guidance.
   */
  const startNextWorkoutDay = (source: 'rest_day_cta' | 'rest_day_redirect') => {
    if (!nextWorkoutDay) {
      toast.info('No workouts in your plan yet', 'Ask your coach in Chat to build your plan.');
      return;
    }

    posthog.capture('workout_started', {
      workout_name: nextWorkoutDay.workout.splitName,
      exercise_count:
        nextWorkoutDay.workout.exercises_structured?.length ??
        nextWorkoutDay.workout.exercises?.length ?? 0,
      moved_up_from: nextWorkoutDay.dayOfWeek,
      source,
    });
    launchMainPlanWorkout(nextWorkoutDay.workout);
  };

  /**
   * Start today's workout
   */
  const startTodaysWorkout = () => {
    if (!selectedWorkout) return;

    // Rest day: never push the player with an empty exercise list (that was a
    // dead-end for the day-1 rest-day cohort). Move the next workout up.
    if (selectedWorkout.isRestDay) {
      startNextWorkoutDay('rest_day_redirect');
      return;
    }

    console.log('Starting main plan workout');
    posthog.capture('workout_started', {
      workout_name: selectedWorkout.splitName,
      exercise_count: selectedWorkout.exercises?.length ?? 0,
    });

    // Resume the active main plan session when one exists
    launchMainPlanWorkout(selectedWorkout, { sessionId: mainPlanSession?.id });
  };

  /**
   * Navigate to settings
   */
  const openSettings = () => {
    router.push('/settings');
  };

  /**
   * Get greeting based on time of day.
   *  5–11  → Good morning
   * 12–16  → Good afternoon
   * 17–21  → Good evening
   * 22–4   → Good night
   */
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    if (hour >= 17 && hour < 22) return 'Good evening';
    return 'Good night';
  };

  /**
   * Handle date selection
   */
  const handleDateSelect = (date: Date) => {
    setSelectedDate(date);

    // Update calendar dates with new selection
    const newCalendarDates = calendarDates.map(calDate => ({
      ...calDate,
      isSelected: calDate.date.toDateString() === date.toDateString(),
    }));
    setCalendarDates(newCalendarDates);

    // Show "Go to Today" button if not today
    setShowGoToToday(!isToday(date));
  };

  /**
   * Go back to today
   */
  const goToToday = () => {
    const today = new Date();
    setSelectedDate(today);
    setShowGoToToday(false);

    // Update calendar dates
    const newCalendarDates = getWeekDates();
    setCalendarDates(newCalendarDates);
  };

  if (authLoading || dataLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top', 'left', 'right']}>
        <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} backgroundColor={colors.background} />
        <HomeSkeleton isDark={isDark} insetsTop={0} />
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top', 'left', 'right']}>
        <KeyboardAvoidingView
          style={[styles.container, { backgroundColor: colors.background }]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
          <StatusBar barStyle={isDark ? "light-content" : "dark-content"} backgroundColor={colors.background} />

          <ScrollView
            ref={scrollViewRef}
            style={styles.mainContent}
            showsVerticalScrollIndicator={false}
            // Extra bottom inset: the native tab bar floats over content
            contentContainerStyle={[styles.scrollContent, { paddingBottom: 32 + insets.bottom + TAB_BAR_CLEARANCE }]}
          >

            {/* Header with greeting + Settings */}
            <View style={styles.header}>
              <View style={styles.headerLeft}>
                <Image
                  source={isDark ? require('../../img/Logo/White-Logo.png') : require('../../img/Logo/Black-Logo.png')}
                  style={styles.logo}
                />
                <Text
                  style={[styles.greetingLine, { color: colors.text }]}
                  numberOfLines={1}
                >
                  {getGreeting()}{userFirstName ? `, ${userFirstName}` : ''}
                </Text>
              </View>
              <View style={styles.headerActions}>
                <TouchableOpacity
                  style={styles.settingsButton}
                  onPress={openSettings}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel="Open settings"
                >
                  <Ionicons name="settings-outline" size={24} color={colors.text} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Calendar Week View */}
            <View style={styles.calendarContainer}>
              <FlatList
                data={calendarDates}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.calendarScroll}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[
                      styles.calendarItem,
                      { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
                      item.isToday && { backgroundColor: colors.primary, borderColor: colors.primary },
                      item.isSelected && { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.backgroundTertiary },
                    ]}
                    onPress={() => handleDateSelect(item.date)}
                  >
                    <Text style={[
                      styles.calendarDayName,
                      { color: colors.textMuted },
                      (item.isToday || item.isSelected) && { color: colors.text },
                    ]}>
                      {item.dayName}
                    </Text>
                    <Text style={[
                      styles.calendarDayNumber,
                      { color: colors.text },
                      (item.isToday || item.isSelected) && { color: colors.text },
                    ]}>
                      {item.dayNumber}
                    </Text>
                  </TouchableOpacity>
                )}
                keyExtractor={(item) => item.date.toISOString()}
              />
            </View>

            {/* Workout Display — the screen's hero: hairline-bordered card. */}
            {selectedWorkout && (
              <View style={[
                styles.workoutCard,
                { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
                selectedWorkout.isRestDay && styles.restDayCard
              ]}>

                {/* Card Header */}
                <View style={styles.workoutCardHeader}>
                  <Text style={[styles.workoutTitle, { color: colors.text }]}>
                    {isToday(selectedDate)
                      ? "Today's Workout"
                      : `${selectedDate.toLocaleDateString('en-US', { weekday: 'long' })}'s Workout`
                    }
                  </Text>
                  <View style={styles.workoutBadgesContainer}>
                    {isReplacementWorkout && !selectedWorkout.isRestDay && (
                      <View style={[styles.replacementBadge, { backgroundColor: colors.info }]}>
                        <Ionicons name="swap-horizontal" size={12} color={colors.textInverse} />
                        <Text style={[styles.replacementBadgeText, { color: colors.textInverse }]}>Replaced</Text>
                      </View>
                    )}
                    {!selectedWorkout.isRestDay && (
                      <View style={[styles.splitBadge, { borderColor: colors.border }]}>
                        <Text style={[styles.splitBadgeText, { color: colors.text }]}>{selectedWorkout.splitName}</Text>
                      </View>
                    )}
                    {/* Manual plan editing — works for workout AND rest days */}
                    <TouchableOpacity
                      style={[styles.editDayButton, { borderColor: colors.border }]}
                      onPress={() =>
                        // Route cast: typed routes regenerate on next `expo start`.
                        router.push({
                          pathname: '/workout/edit-day',
                          params: {
                            dayOfWeek: selectedDate
                              .toLocaleDateString('en-US', { weekday: 'long' })
                              .toLowerCase(),
                          },
                        } as any)
                      }
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityLabel="Edit this day's workout"
                    >
                      <Ionicons name="pencil" size={13} color={colors.text} />
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Rest Day Content */}
                {selectedWorkout.isRestDay ? (
                  <View style={styles.restDayContent}>
                    <View style={[styles.restDayIconWrap, { backgroundColor: isDark ? 'rgba(46,144,250,0.12)' : '#EAF3FF' }]}>
                      <Ionicons name="bed-outline" size={28} color={colors.primary} />
                    </View>
                    <Text style={[styles.restDayTitle, { color: colors.text }]}>Rest Day</Text>
                    <Text style={[styles.restDayText, { color: colors.textMuted }]}>
                      Recovery is where your body grows stronger. Make it count:
                    </Text>
                    <View style={styles.recoveryList}>
                      {[
                        { icon: 'body-outline' as const, label: '10 min of light stretching or mobility' },
                        { icon: 'walk-outline' as const, label: 'An easy walk — 20–30 minutes' },
                        { icon: 'water-outline' as const, label: 'Stay hydrated through the day' },
                        { icon: 'moon-outline' as const, label: 'Aim for 7–9 hours of sleep tonight' },
                      ].map((item) => (
                        <View key={item.icon} style={styles.recoveryRow}>
                          <Ionicons name={item.icon} size={18} color={colors.primary} />
                          <Text style={[styles.recoveryText, { color: colors.textSecondary }]}>{item.label}</Text>
                        </View>
                      ))}
                    </View>

                    {/* A rest day still needs a primary action — the day-1
                        rest-day cohort churned on this card when it offered
                        nothing to do. "Train today" moves the next scheduled
                        workout up; the coach link keeps rest days engaged. */}
                    {isToday(selectedDate) && (
                      <View style={styles.restDayActions}>
                        {nextWorkoutDay && (
                          <TouchableOpacity
                            style={[styles.startWorkoutButton, { backgroundColor: colors.text }]}
                            onPress={() => startNextWorkoutDay('rest_day_cta')}
                            accessibilityRole="button"
                            accessibilityLabel={`Train today anyway — start ${nextWorkoutDay.workout.splitName}`}
                          >
                            <Ionicons name="play" size={20} color={colors.textInverse} />
                            <Text
                              style={[styles.startWorkoutButtonText, { color: colors.textInverse }]}
                              numberOfLines={1}
                            >
                              Train today · {nextWorkoutDay.workout.splitName}
                            </Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity
                          style={[styles.viewDetailsButton, { borderColor: colors.border }]}
                          onPress={() =>
                            router.push({
                              pathname: '/(tabs)/chat',
                              params: { initialMessage: 'What should I do on my rest day today?' },
                            })
                          }
                          accessibilityRole="button"
                          accessibilityLabel="Ask your coach about recovery"
                        >
                          <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.text} />
                          <Text style={[styles.viewDetailsButtonText, { color: colors.text }]}>
                            Ask your coach about recovery
                          </Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                ) : (
                  /* Workout Day Content - ONLY show stats and exercises when NOT rest day */
                  <>
                    {/* Quick Stats — paywall stat-chip row */}
                    <View style={styles.workoutStats}>
                      <StatChip value={`${selectedWorkout.exercises.length}`} label="exercises" />
                      <StatChip value={`${selectedWorkout.estimatedTime}`} label="minutes" />
                    </View>

                    {/* Exercise Preview List */}
                    {selectedWorkout.exercises && selectedWorkout.exercises.length > 0 && (
                      <View style={styles.exercisePreviewSection}>
                        <Text style={[styles.exercisePreviewLabel, { color: colors.textMuted }]}>Exercises:</Text>
                        <View style={styles.exercisePreviewList}>
                          {selectedWorkout.exercises.slice(0, 4).map((exercise: string | { name?: string }, index: number) => {
                            const exerciseName = typeof exercise === 'string' ? exercise : (exercise as { name?: string }).name ?? '';
                            return (
                              <View key={index} style={styles.exercisePreviewItem}>
                                <View style={[styles.exercisePreviewDot, { backgroundColor: colors.primary }]} />
                                <Text style={[styles.exercisePreviewText, { color: colors.text }]} numberOfLines={1}>
                                  {exerciseName}
                                </Text>
                              </View>
                            );
                          })}
                          {selectedWorkout.exercises.length > 4 && (
                            <Text style={[styles.exercisePreviewMore, { color: colors.textMuted }]}>
                              +{selectedWorkout.exercises.length - 4} more
                            </Text>
                          )}
                        </View>
                      </View>
                    )}
                  </>
                )}

                {/* Action Buttons */}
                <View style={styles.workoutActions}>
                  {isToday(selectedDate) && !selectedWorkout.isRestDay && (
                    <TouchableOpacity
                      style={[styles.startWorkoutButton, { backgroundColor: colors.text }]}
                      onPress={() => {
                        // Check for main plan session first (not chat/saved)
                        if (mainPlanSession) {
                          // Resume main plan workout
                          router.push({
                            pathname: '/workout',
                            params: {
                              exercises: JSON.stringify(mainPlanSession.exercises),
                              exerciseStructure: JSON.stringify(mainPlanSession.structuredExercises || []),
                              exerciseNames: JSON.stringify(mainPlanSession.exercises),
                              workoutName: mainPlanSession.workoutName,
                              estimatedTime: String(mainPlanSession.estimatedTime || 0),
                              difficulty: 'personalized',
                              workoutType: 'main_plan',
                              sessionId: mainPlanSession.id
                            }
                          });
                        } else {
                          // Start fresh main plan workout (also the re-do path
                          // after today's workout was completed).
                          startTodaysWorkout();
                        }
                      }}
                    >
                      <Ionicons
                        name={mainPlanSession ? 'play-circle' : mainWorkoutDoneToday ? 'refresh' : 'play'}
                        size={20}
                        color={colors.textInverse}
                      />
                      <Text style={[styles.startWorkoutButtonText, { color: colors.textInverse }]}>
                        {mainPlanSession ? 'Continue Workout' : mainWorkoutDoneToday ? 'Re-do Workout' : 'Start Workout'}
                      </Text>
                    </TouchableOpacity>
                  )}

                  {/* View Details Button - Only show on workout days */}
                  {!selectedWorkout.isRestDay && (
                    <TouchableOpacity
                      style={[styles.viewDetailsButton, { borderColor: colors.border }]}
                      onPress={() => setShowWorkoutPreview(true)}
                    >
                      <Ionicons name="list-outline" size={18} color={colors.text} />
                      <Text style={[styles.viewDetailsButtonText, { color: colors.text }]}>View Details</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

            {/* Continue Active Workout Banner - Only show chat/saved workouts (not main plan or replacement) */}
            {activeSession &&
              activeSession.workoutType !== 'main_plan' &&
              activeSession.workoutType !== 'replacement_workout' &&
              isToday(selectedDate) && (
                <View style={[styles.continueBanner, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                  {/* Header with title and close button */}
                  <View style={styles.continueBannerHeader}>
                    <Text style={[styles.continueBannerTitle, { color: colors.text }]}>Resume Workout</Text>
                    <TouchableOpacity
                      style={[styles.dismissButton, { backgroundColor: isDark ? '#2A2A2A' : '#EFEFEF' }]}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      accessibilityLabel="Dismiss active workout"
                      onPress={async () => {
                        // Only clear the chat/saved workout session (not main plan)
                        if (activeSession?.workoutType) {
                          await clearActiveWorkoutSession(activeSession.workoutType);
                        } else {
                          await clearActiveWorkoutSession('extra_workout');
                        }
                        setActiveSession(null);
                        await loadTodaysWorkout();
                        await loadActiveSessions();
                      }}
                    >
                      <Ionicons name="close" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                  </View>

                  {/* Workout info: icon on left, name and button stacked on right */}
                  <View style={styles.continueBannerContent}>
                    <View style={[styles.continueBannerIconCircle, { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.05)' }]}>
                      <Ionicons name="barbell" size={20} color={colors.text} />
                    </View>
                    <View style={styles.continueBannerRight}>
                      <Text style={[styles.continueBannerWorkoutName, { color: colors.text }]}>
                        {activeSession.workoutName}
                      </Text>
                      <TouchableOpacity
                        style={[styles.continueButton, { backgroundColor: colors.text }]}
                        onPress={() => {
                          router.push({
                            pathname: '/workout',
                            params: {
                              exercises: JSON.stringify(activeSession.exercises),
                              exerciseStructure: JSON.stringify(activeSession.structuredExercises || []),
                              exerciseNames: JSON.stringify(activeSession.exercises),
                              workoutName: activeSession.workoutName,
                              estimatedTime: String(activeSession.estimatedTime || 0),
                              difficulty: 'personalized',
                              workoutType: activeSession.workoutType || 'extra_workout',
                              sessionId: activeSession.id
                            }
                          });
                        }}
                      >
                        <Ionicons name="play" size={14} color={colors.textInverse} />
                        <Text style={[styles.continueButtonText, { color: colors.textInverse }]}>Continue</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              )}

            {/* Go to Today Button */}
            {showGoToToday && (
              <TouchableOpacity style={styles.goToTodayButton} onPress={goToToday}>
                <Ionicons name="calendar-outline" size={18} color={colors.text} />
                <Text style={[styles.goToTodayText, { color: colors.text }]}>Go to Today</Text>
              </TouchableOpacity>
            )}

            {/* Guided first week — replaces a feature tour with three real
                actions, each a taste of a core feature. Renders nothing after
                day 10 / completion / dismissal. */}
            {userId && isToday(selectedDate) && (
              <Week1ChecklistCard userId={userId} onStartWorkout={startTodaysWorkout} />
            )}

            {/* Proactive coach check-in (progress nudge / plan-change note) */}
            {userId && isToday(selectedDate) && <CoachCheckinCard />}

            {/* At-a-glance metrics: streak milestone, today's macros, weight trend */}
            {userId && isToday(selectedDate) && (
              <HomeMetricsRow userId={userId} />
            )}

            {/* Consistency Tracker */}
            {userId && (
              <View style={styles.consistencyCalendarWrapper}>
                <ConsistencyCalendar userId={userId} />
              </View>
            )}

            {/* AI Trainer Question Box */}
            <View style={[styles.aiQuestionCard, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
              <View style={styles.aiQuestionHeader}>
                <Text style={[styles.aiQuestionLabel, { color: colors.text }]}>Ask your AI trainer</Text>
              </View>
              <View style={styles.aiQuestionRow}>
                <View style={[
                  styles.aiQuestionInputContainer,
                  {
                    backgroundColor: isDark ? '#D3D3D3' : 'transparent',
                    borderColor: isDark ? '#D3D3D3' : colors.border
                  }
                ]}>
                  <TextInput
                    ref={aiInputRef}
                    style={[styles.aiQuestionInput, { color: isDark ? '#000000' : colors.text }]}
                    placeholder="Type your question..."
                    placeholderTextColor={isDark ? '#666666' : colors.textMuted}
                    value={aiQuestion}
                    onChangeText={setAiQuestion}
                    onFocus={() => {
                      setTimeout(() => {
                        scrollViewRef.current?.scrollToEnd({ animated: true });
                      }, 100);
                    }}
                    onSubmitEditing={() => {
                      if (aiQuestion.trim()) {
                        router.push({
                          pathname: '/(tabs)/chat',
                          params: { initialMessage: aiQuestion.trim() }
                        });
                        setAiQuestion('');
                      }
                    }}
                    returnKeyType="send"
                  />
                </View>
                <TouchableOpacity
                  style={[styles.aiQuestionSendButton, { backgroundColor: isDark ? '#FFFFFF' : '#000000' }]}
                  onPress={() => {
                    if (aiQuestion.trim()) {
                      router.push({
                        pathname: '/(tabs)/chat',
                        params: { initialMessage: aiQuestion.trim() }
                      });
                      setAiQuestion('');
                    }
                  }}
                >
                  <Ionicons name="send" size={20} color={colors.textInverse} />
                </TouchableOpacity>
              </View>

              {/* View Saved Workouts Link */}
              <TouchableOpacity
                style={styles.savedWorkoutsLink}
                onPress={() => router.push('/(tabs)/saved')}
              >
                <Text style={[styles.savedWorkoutsLinkText, { color: colors.textMuted }]}>View your saved workouts</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </TouchableOpacity>

              <AdBanner style={{ marginTop: 16 }} />
            </View>
          </ScrollView>

        </KeyboardAvoidingView>
      </SafeAreaView>

      <ExerciseSearchSheet visible={exerciseSearchOpen} onClose={() => setExerciseSearchOpen(false)} />

      {/* Workout Preview Modal */}
      {showWorkoutPreview && selectedWorkout && !selectedWorkout.isRestDay && (
        <View style={[styles.workoutPreviewModal, { backgroundColor: colors.background }]}>
          <StatusBar barStyle={isDark ? "light-content" : "dark-content"} backgroundColor={colors.background} />
          <View style={[styles.workoutPreviewContent, { backgroundColor: colors.background }]}>
            {/* Header */}
            <View style={[styles.workoutPreviewHeader, { borderBottomColor: colors.border }]}>
              <GlassIconButton
                icon="close"
                size={40}
                iconSize={22}
                onPress={() => setShowWorkoutPreview(false)}
                accessibilityLabel="Close workout preview"
                style={styles.closeButton}
              />
              <Text style={[styles.workoutPreviewTitle, { color: colors.text }]}>{selectedWorkout.splitName}</Text>
              <Text style={[styles.workoutPreviewSubtitle, { color: colors.textMuted }]}>
                {selectedWorkout.exercises.length} exercises • {selectedWorkout.estimatedTime} min
              </Text>
            </View>

            {/* Exercise List */}
            <ScrollView
              style={styles.workoutPreviewExerciseList}
              contentContainerStyle={{ paddingBottom: isToday(selectedDate) ? 8 : insets.bottom + TAB_BAR_CLEARANCE + 8 }}
              showsVerticalScrollIndicator={false}
            >
              {selectedWorkout.exercises.map((exercise: string | { name?: string; gif_path?: string | null }, index: number) => {
                const exerciseName = typeof exercise === 'string' ? exercise : (exercise as { name?: string }).name ?? '';
                const structuredEx = selectedWorkout.exercises_structured?.[index];
                const gifPath = (typeof exercise === 'object' && exercise?.gif_path) || structuredEx?.gif_path || null;
                const gifUrl = gifPath ? getExerciseGifUrl(gifPath) : null;
                return (
                  <View key={index} style={[styles.workoutPreviewExerciseCard, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                    <View style={styles.workoutPreviewExerciseInfo}>
                      {gifUrl ? (
                        <ExpoImage
                          source={{ uri: gifUrl }}
                          style={styles.workoutPreviewExerciseThumb}
                          contentFit="contain"
                        />
                      ) : (
                        <View style={[styles.workoutPreviewExerciseThumb, styles.workoutPreviewExerciseThumbEmpty, { backgroundColor: colors.background }]}>
                          <Ionicons name="barbell-outline" size={18} color={colors.textMuted} />
                        </View>
                      )}
                      <Text style={[styles.workoutPreviewExerciseName, { color: colors.text }]}>{exerciseName}</Text>
                      <Text style={[styles.workoutPreviewExerciseSets, { color: colors.textMuted }]}>
                        {`${structuredEx?.sets ?? 3} sets`}
                        {structuredEx?.reps ? ` × ${structuredEx.reps}` : ''}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>

            {/* Start/Continue Workout Button */}
            {isToday(selectedDate) && (
              <TouchableOpacity
                style={[styles.workoutPreviewStartButton, { backgroundColor: colors.text, marginBottom: 20 + insets.bottom + TAB_BAR_CLEARANCE }]}
                onPress={() => {
                  setShowWorkoutPreview(false);
                  // Check for main plan session first
                  if (mainPlanSession) {
                    router.push({
                      pathname: '/workout',
                      params: {
                        exercises: JSON.stringify(mainPlanSession.exercises),
                        exerciseStructure: JSON.stringify(mainPlanSession.structuredExercises || []),
                        exerciseNames: JSON.stringify(mainPlanSession.exercises),
                        workoutName: mainPlanSession.workoutName,
                        estimatedTime: String(mainPlanSession.estimatedTime || 0),
                        difficulty: 'personalized',
                        workoutType: 'main_plan',
                        sessionId: mainPlanSession.id
                      }
                    });
                  } else {
                    startTodaysWorkout();
                  }
                }}
              >
                <Ionicons
                  name={mainPlanSession ? 'play-circle' : mainWorkoutDoneToday ? 'refresh' : 'play'}
                  size={20}
                  color={colors.textInverse}
                />
                <Text style={[styles.workoutPreviewStartButtonText, { color: colors.textInverse }]}>
                  {mainPlanSession ? 'Continue Workout' : mainWorkoutDoneToday ? 'Re-do Workout' : 'Start Workout'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ... keep the same styles ...
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mainContent: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 32, // Reduced padding for cleaner layout
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    fontFamily: 'Montserrat_400Regular',
    marginTop: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 16,
  },
  headerLeft: {
    flex: 1,
    minWidth: 0,
  },
  logo: {
    width: 80,
    height: 36,
    marginBottom: 8,
    resizeMode: 'contain',
  },
  greetingLine: {
    marginTop: 4,
    fontSize: 20,
    fontFamily: 'Montserrat_700Bold',
    letterSpacing: -0.3,
    lineHeight: 26,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  settingsButton: {
    padding: 12,
    borderRadius: 12,
    marginTop: 4,
  },
  // Calendar styles
  calendarContainer: {
    marginBottom: 16,
  },
  calendarScroll: {
    paddingHorizontal: 20,
    gap: 8,
  },
  calendarItem: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 40,
  },
  calendarItemToday: {
  },
  calendarItemSelected: {
  },
  calendarDayName: {
    fontSize: 12,
    fontFamily: 'Montserrat_600SemiBold',
    marginBottom: 4,
  },
  calendarDayNameHighlight: {
  },
  calendarDayNumber: {
    fontSize: 16,
    fontFamily: 'Montserrat_700Bold',
  },
  calendarDayNumberHighlight: {
  },
  // Workout card styles
  // Hero stage: centers the glow behind the card.
  workoutCard: {
    alignSelf: 'stretch',
    marginHorizontal: 20,
    marginBottom: 8,
    borderRadius: 20,
    borderWidth: 1,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  workoutCardHeader: {
    marginBottom: 12,
  },
  workoutTitle: {
    fontSize: 20,
    fontFamily: 'Montserrat_700Bold',
    marginBottom: 8,
  },
  workoutBadgesContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  splitBadge: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  splitBadgeText: {
    fontSize: 14,
    fontFamily: 'Montserrat_600SemiBold',
  },
  editDayButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  replacementBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  replacementBadgeText: {
    fontSize: 12,
    fontFamily: 'Montserrat_600SemiBold',
    marginLeft: 4,
  },
  workoutStats: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    paddingVertical: 4,
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statNumber: {
    fontSize: 20,
    fontFamily: 'Montserrat_700Bold',
    marginTop: 2,
  },
  statLabel: {
    fontSize: 12,
    fontFamily: 'Montserrat_500Medium',
    marginTop: 1,
  },
  exercisePreviewSection: {
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  exercisePreviewLabel: {
    fontSize: 14,
    fontFamily: 'Montserrat_600SemiBold',
    marginBottom: 8,
  },
  exercisePreviewList: {
    gap: 8,
  },
  exercisePreviewItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  exercisePreviewDot: {
    width: 6,
    height: 6,
    borderRadius: 4,
  },
  exercisePreviewText: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Montserrat_500Medium',
  },
  exercisePreviewMore: {
    fontSize: 14,
    fontFamily: 'Montserrat_500Medium',
    fontStyle: 'italic',
    marginTop: 4,
    marginLeft: 16,
  },
  muscleGroupsSection: {
    marginBottom: 12,
  },
  muscleGroupsLabel: {
    fontSize: 12,
    fontFamily: 'Montserrat_600SemiBold',
    marginBottom: 8,
  },
  muscleGroupsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  musclePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    gap: 4,
  },
  musclePillText: {
    fontSize: 12,
    fontFamily: 'Montserrat_500Medium',
  },
  workoutActions: {
    gap: 8,
  },
  startWorkoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 20,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  startWorkoutButtonText: {
    fontSize: 14,
    fontFamily: 'Montserrat_600SemiBold',
  },
  viewDetailsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
  },
  viewDetailsButtonText: {
    fontSize: 12,
    fontFamily: 'Montserrat_500Medium',
  },
  // Rest day card styles (applied conditionally to workoutCard)
  restDayCard: {
    borderWidth: 1,
  },
  restDayContent: {
    alignItems: 'center',
  },
  restDayIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recoveryList: {
    alignSelf: 'stretch',
    marginTop: 16,
    gap: 12,
  },
  restDayActions: {
    alignSelf: 'stretch',
    marginTop: 20,
    gap: 8,
  },
  recoveryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  recoveryText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Montserrat_500Medium',
    lineHeight: 20,
  },
  restDayTitle: {
    fontSize: 20,
    fontFamily: 'Montserrat_700Bold',
    marginTop: 12,
    marginBottom: 8,
  },
  restDayText: {
    fontSize: 14,
    fontFamily: 'Montserrat_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  // Consistency Calendar wrapper
  consistencyCalendarWrapper: {
    marginTop: 16,
    marginBottom: 16,
  },
  // AI Trainer Question Section
  aiQuestionCard: {
    marginHorizontal: 20,
    marginTop: 8,
    marginBottom: 0,
    borderRadius: 20,
    borderWidth: 1,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  aiQuestionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  aiQuestionLabel: {
    fontSize: 14,
    fontFamily: 'Montserrat_600SemiBold',
  },
  aiQuestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  aiQuestionInputContainer: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 2,
  },
  aiQuestionInput: {
    fontSize: 14,
    fontFamily: 'Montserrat_400Regular',
    paddingVertical: 8,
  },
  aiQuestionSendButton: {
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Saved workouts link
  savedWorkoutsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 0,
    paddingVertical: 4, // Reduced padding
    marginTop: 4,
  },
  savedWorkoutsLinkText: {
    fontSize: 12,
    marginRight: 4,
  },
  // Go to today button
  goToTodayButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 8,
    borderWidth: 1,
    gap: 8,
  },
  goToTodayText: {
    fontSize: 14,
    fontWeight: '600',
  },
  // Workout Preview Modal Styles
  workoutPreviewModal: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2000,
    elevation: 2000,
  },
  workoutPreviewContent: {
    flex: 1,
    paddingTop: Platform.OS === 'ios' ? 50 : 30,
  },
  workoutPreviewHeader: {
    padding: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  closeButton: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 50 : 30,
    right: 20,
    zIndex: 10,
  },
  workoutPreviewTitle: {
    fontSize: 24,
    fontFamily: 'Montserrat_700Bold',
    marginBottom: 8,
    marginTop: 20,
    marginRight: 60, // Add space for close button
    paddingRight: 8, // Extra padding for better spacing
    flexWrap: 'wrap',
  },
  workoutPreviewSubtitle: {
    fontSize: 16,
    fontFamily: 'Montserrat_500Medium',
    marginRight: 60, // Add space for close button
    paddingRight: 8, // Extra padding for better spacing
  },
  workoutPreviewExerciseList: {
    flex: 1,
    padding: 20,
  },
  workoutPreviewExerciseCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
  },
  workoutPreviewExerciseInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  workoutPreviewExerciseName: {
    fontSize: 16,
    fontFamily: 'Montserrat_700Bold',
    flex: 1,
    marginLeft: 12,
  },
  workoutPreviewExerciseSets: {
    fontSize: 14,
    fontFamily: 'Montserrat_500Medium',
  },
  workoutPreviewExerciseThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
  },
  workoutPreviewExerciseThumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  workoutPreviewStartButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    margin: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  workoutPreviewStartButtonText: {
    fontSize: 18,
    fontFamily: 'Montserrat_700Bold',
    marginLeft: 8,
  },
  continueBanner: {
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
  },
  continueBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  continueBannerTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  continueBannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  continueBannerIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  continueBannerRight: {
    flex: 1,
    gap: 8,
  },
  continueBannerWorkoutName: {
    fontSize: 15,
    fontWeight: '600',
  },
  continueButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 12,
    gap: 8,
  },
  continueButtonText: {
    fontWeight: '700',
    fontSize: 13,
  },
  dismissButton: {
    width: 28,
    height: 28,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
