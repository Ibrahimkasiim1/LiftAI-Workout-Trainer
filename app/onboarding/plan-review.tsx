// app/enhanced-plan-review.tsx
/**
 * Enhanced Plan Review Screen
 * 
 * Route: /enhanced-plan-review
 * Function: Advanced workout plan editing with searchable exercise database
 * 
 * Features:
 * - Display generated workout plan with detailed exercise information
 * - Searchable exercise database with filtering
 * - Add/remove exercises from workout days
 * - Exercise details with sets, reps, and target muscles
 * - Body part categorization and visualization
 * - Plan validation and confirmation
 * - Integration with exercise database and AI system
 */

import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { getExerciseGifUrl } from '../../utils/exerciseGifs';
import { formatExerciseName } from '../../utils/exerciseName';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../../constants/theme';
import { useSubscription } from '../../context/SubscriptionContext';
import { useTheme } from '../../context/ThemeContext';
import { toast } from '../../components/ui/Toast';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { loadExerciseDatabase } from '../../utils/openai';
import { posthog } from '../../src/config/posthog';
import { writeFunnelSnapshot } from '../../utils/funnelState';
import { supabase } from '../../utils/supabase';
import { completeOnboarding, getUserProfile } from '../../utils/userProfile';

// Body part icon mapping
const BODY_PART_ICONS: { [key: string]: string } = {
  'lower back': 'arrow-down-circle-outline',
  'upper back': 'fitness-outline',
  'shoulders': 'radio-button-on-outline',
  'chest': 'body-outline',
  'biceps': 'trending-up-outline',
  'triceps': 'trending-down-outline',
  'legs': 'walk-outline',
  'quads': 'walk-outline',
  'hamstrings': 'reorder-two-outline',
  'calves': 'footsteps-outline',
  'core': 'grid-outline',
  'abs': 'grid-outline',
  'glutes': 'ellipse-outline',
  'general': 'fitness-outline'
};

// Interface for workout plan data
interface WorkoutPlan {
  id: string;
  user_id: string;
  plan_name: string;
  created_at: string;
  is_active: boolean;
}

interface DailyWorkout {
  id: string;
  plan_id: string;
  day_of_week: string;
  split_day_name: string;
  exercises: string[];
  exercises_structured?: any[];
  estimated_time: number;
  notes?: string;
}

interface Exercise {
  id: string;
  name: string;
  bodyPart: string;
  equipment: string;
  target: string;
  secondaryMuscles: string[];
  instructions: string[];
  description: string;
  difficulty: string;
  category: string;
  popularityScore?: number;
  easeScore?: number;
  gif_path?: string | null;
}

/**
 * Utility function to convert text to Title Case
 */
const toTitleCase = (str: string): string => {
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

export default function EnhancedPlanReviewScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const { session, loading: authLoading } = useRequireAuth();
  const { isLoading: subscriptionLoading, isInitialized } = useSubscription();
  const subscriptionReady = isInitialized && !subscriptionLoading;

  // Confirmation must never dead-end on RevenueCat. handleConfirmPlan doesn't
  // actually need subscription state (the paywall already ran earlier in the
  // funnel) — so if the SDK hasn't initialized within a few seconds (offline,
  // StoreKit hiccup), enable the CTA anyway. Without this, users whose SDK
  // init stalls are re-routed here on every launch by the funnel guard and
  // face a permanently disabled button.
  const [subscriptionWaitExpired, setSubscriptionWaitExpired] = useState(false);
  useEffect(() => {
    if (subscriptionReady || subscriptionWaitExpired) return;
    const timer = setTimeout(() => {
      setSubscriptionWaitExpired(true);
      posthog.capture('plan_review_subscription_wait_expired');
    }, 8000);
    return () => clearTimeout(timer);
  }, [subscriptionReady, subscriptionWaitExpired]);
  const canConfirm = subscriptionReady || subscriptionWaitExpired;

  const [plan, setPlan] = useState<WorkoutPlan | null>(null);
  const [dailyWorkouts, setDailyWorkouts] = useState<DailyWorkout[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [selectedDay, setSelectedDay] = useState<DailyWorkout | null>(null);
  const [exerciseDatabase, setExerciseDatabase] = useState<Exercise[]>([]);
  const [filteredExercises, setFilteredExercises] = useState<Exercise[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBodyPart, setSelectedBodyPart] = useState<string>('all');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('all');
  const [filtersSheetVisible, setFiltersSheetVisible] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [showChangesApplied, setShowChangesApplied] = useState(false);
  const [dayAssignments, setDayAssignments] = useState<{ [key: string]: string }>({});
  const pulseAnim = useState(new Animated.Value(1))[0];

  const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  useEffect(() => {
    if (!authLoading && session) {
      loadWorkoutPlan();
    }
  }, [authLoading, session]);

  useEffect(() => {
    if (!authLoading && session) {
      posthog.capture('plan_review_viewed');
      writeFunnelSnapshot('hard_paywall', {
        route: '/onboarding/plan-review',
        reason: 'hard_paywall_screen',
      });
    }
  }, [authLoading, session]);

  useEffect(() => {
    filterExercises();
  }, [exerciseDatabase, searchQuery, selectedBodyPart, selectedDifficulty]);

  // Pulsing animation for AI button
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.05,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  /**
   * Load the generated workout plan
   */
  const loadWorkoutPlan = async () => {
    if (!session) return;

    try {
      setDataLoading(true);

      // Load user profile
      const { profile } = await getUserProfile(session.user.id);
      if (profile) {
        setUserProfile(profile);
      }

      // Load exercise database
      const exercises = await loadExerciseDatabase();
      setExerciseDatabase(exercises);

      // Get the active workout plan
      const { data: planData, error: planError } = await supabase
        .from('workout_plans')
        .select('*')
        .eq('user_id', session.user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (planError || !planData) {
        toast.error('No workout plan found', 'Please try again.');
        router.replace('/onboarding');
        return;
      }

      setPlan(planData as WorkoutPlan);

      // Get daily workouts for this plan
      const { data: workoutsData, error: workoutsError } = await supabase
        .from('daily_workouts')
        .select('*')
        .eq('plan_id', planData.id)
        .order('day_of_week');

      if (workoutsError) {
        toast.error('Failed to load workout details');
        return;
      }

      setDailyWorkouts((workoutsData || []) as DailyWorkout[]);

      // Initialize day assignments from existing day_of_week values
      // Since workouts are saved with valid day names (monday, tuesday, etc.) due to DB constraint,
      // we initialize with those values, but user can reassign them
      const initialAssignments: { [key: string]: string } = {};
      (workoutsData || []).forEach((workout: any) => {
        // day_of_week should be a valid day name (monday, tuesday, etc.) from database
        if (DAYS_OF_WEEK.includes(workout.day_of_week.toLowerCase())) {
          initialAssignments[workout.day_of_week] = workout.day_of_week.toLowerCase();
        } else {
          // Fallback: initialize empty for user to assign
          initialAssignments[workout.day_of_week] = '';
        }
      });
      setDayAssignments(initialAssignments);

    } catch (error) {
      console.error('Error loading workout plan:', error);
      toast.error('Something went wrong', 'Please try again.');
    } finally {
      setDataLoading(false);
    }
  };

  /**
   * Filter exercises based on search query, body part, and difficulty
   */
  const filterExercises = () => {
    let filtered = exerciseDatabase;

    // Filter by search query
    if (searchQuery.trim()) {
      filtered = filtered.filter(exercise =>
        exercise.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        exercise.target.toLowerCase().includes(searchQuery.toLowerCase()) ||
        exercise.bodyPart.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Filter by body part
    if (selectedBodyPart !== 'all') {
      filtered = filtered.filter(exercise =>
        exercise.target.toLowerCase() === selectedBodyPart.toLowerCase() ||
        exercise.bodyPart.toLowerCase() === selectedBodyPart.toLowerCase()
      );
    }

    // Filter by difficulty
    if (selectedDifficulty !== 'all') {
      filtered = filtered.filter(exercise =>
        exercise.difficulty === selectedDifficulty
      );
    }

    // Sort by popularity (most popular first)
    filtered.sort((a, b) => {
      const aScore = a.popularityScore || 0;
      const bScore = b.popularityScore || 0;
      return bScore - aScore;
    });

    setFilteredExercises(filtered);
  };

  /**
   * Handle day assignment change
   */
  const handleDayAssignment = (workoutDay: string, dayOfWeek: string) => {
    // If the target day already belongs to another workout, SWAP the two
    // assignments instead of erroring — blocking made a simple A↔B day swap
    // impossible without unassigning one first (daily_workouts has no unique
    // (plan_id, day_of_week) constraint, so the confirm-time updates are safe).
    const assignedTo = Object.keys(dayAssignments).find(
      key => dayAssignments[key] === dayOfWeek && key !== workoutDay
    );

    if (assignedTo && dayOfWeek !== '') {
      const otherName =
        dailyWorkouts.find(w => w.day_of_week === assignedTo)?.split_day_name ?? 'the other workout';
      setDayAssignments(prev => ({
        ...prev,
        [workoutDay]: dayOfWeek,
        [assignedTo]: prev[workoutDay] ?? '',
      }));
      toast.info(
        'Days swapped',
        `${toTitleCase(dayOfWeek)} was taken by ${otherName} — the two workouts traded days.`
      );
      return;
    }

    setDayAssignments(prev => ({
      ...prev,
      [workoutDay]: dayOfWeek
    }));
  };

  /**
   * Handle plan confirmation - "Start This Plan" button
   *
   * SECOND (soft) PAYWALL: non-subscribers see the paywall one more time here,
   * but the result is ignored — they continue to the app either way (free plan
   * with ads). Subscribers are never re-prompted. There is no hard gate.
   */
  const handleConfirmPlan = async () => {
    if (!session) return;
    if (!canConfirm) return;

    try {
      setConfirming(true);

      // Validate all workouts have day assignments FIRST (before paywall)
      const unassignedWorkouts = dailyWorkouts.filter(workout => {
        const assigned = dayAssignments[workout.day_of_week];
        return !assigned || assigned === '';
      });

      if (unassignedWorkouts.length > 0) {
        toast.error('Missing assignments', 'Assign a day of the week to every workout before confirming.');
        setConfirming(false);
        return;
      }

      // NOTE: The second onboarding paywall that used to present here was
      // removed — the single conversion moment is the ConversionPaywall on
      // /onboarding/paywall. Showing the same paywall twice within a minute
      // felt naggy and converted ~nothing on the second view.

      // Update day_of_week for all workouts in database
      const updatePromises = dailyWorkouts.map(workout => {
        const assignedDay = dayAssignments[workout.day_of_week];
        if (assignedDay && assignedDay.toLowerCase() !== workout.day_of_week.toLowerCase()) {
          return supabase
            .from('daily_workouts')
            .update({ day_of_week: assignedDay })
            .eq('id', workout.id);
        }
        return Promise.resolve({ data: null, error: null });
      });

      const results = await Promise.all(updatePromises);
      const errors = results.filter(r => r.error);

      if (errors.length > 0) {
        console.error('Error updating day assignments:', errors);
        toast.error('Failed to save day assignments', 'Please try again.');
        setConfirming(false);
        return;
      }

      // Mark onboarding as completed
      const { error } = await completeOnboarding(session.user.id);
      if (error) {
        toast.error('Failed to complete onboarding', 'Please try again.');
        setConfirming(false);
        return;
      }

      console.log('Onboarding completed successfully');

      // First-workout moment: never drop a fresh user on the dashboard —
      // land them one tap from actually training while the plan reveal is
      // still hot. That screen owns the notification-setup handoff (the
      // "remind me later" path is the natural permission context).
      await writeFunnelSnapshot('main_app', {
        route: '/(tabs)',
        reason: 'onboarding_completed',
      });
      router.replace('/onboarding/first-workout' as any);

    } catch (error) {
      console.error('Error confirming plan:', error);
      toast.error('Something went wrong', 'Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  /**
   * Handle editing a specific day
   */
  const handleEditDay = (day: DailyWorkout) => {
    setSelectedDay(day);
    setEditModalVisible(true);
    setSearchQuery('');
    setSelectedBodyPart('all');
    setSelectedDifficulty('all');
  };


  /**
   * Add exercise to selected day
   */
  const addExerciseToDay = async (exercise: Exercise) => {
    if (!selectedDay) return;

    // Check if exercise already exists
    const currentExercises = selectedDay.exercises_structured || selectedDay.exercises || [];
    const exerciseExists = currentExercises.some((ex: any) =>
      (typeof ex === 'string' ? ex : ex.name) === exercise.name
    );

    if (exerciseExists) {
      toast.info('Already added', 'This exercise is already in your workout.');
      return;
    }

    // Check exercise limit (max 15)
    if (currentExercises.length >= 15) {
      toast.info('Exercise limit reached', 'You can add a maximum of 15 exercises per workout.');
      return;
    }

    try {
      // Create structured exercise data
      const structuredExercise = {
        name: exercise.name,
        sets: userProfile?.fitness_level === 'beginner' ? 3 : userProfile?.fitness_level === 'expert' ? 5 : 4,
        reps: exercise.category === 'strength' ? '6-8' : exercise.category === 'cardio' ? '30-60s' : '8-12',
        rest_seconds: userProfile?.fitness_level === 'beginner' ? 90 : userProfile?.fitness_level === 'expert' ? 45 : 60,
        target_muscle: exercise.target,
        body_part: exercise.bodyPart,
      };

      // Update local state
      const updatedExercises = [...currentExercises, structuredExercise];
      const updatedExercisesNames = updatedExercises.map((ex: any) =>
        typeof ex === 'string' ? ex : ex.name
      );

      const estimatedTime = calculateWorkoutTime(updatedExercises);

      setDailyWorkouts(prev =>
        prev.map(workout =>
          workout.id === selectedDay.id
            ? {
              ...workout,
              exercises: updatedExercisesNames,
              exercises_structured: updatedExercises,
              estimated_time: estimatedTime
            }
            : workout
        )
      );

      // Update selected day
      setSelectedDay(prev => prev ? {
        ...prev,
        exercises: updatedExercisesNames,
        exercises_structured: updatedExercises,
        estimated_time: estimatedTime
      } : null);

      // Auto-save to database to prevent data loss
      await saveWorkoutExercises(selectedDay.id, updatedExercisesNames, updatedExercises, estimatedTime);

      // Show success message
      toast.success('Exercise added', `${exercise.name} added to your ${selectedDay.split_day_name} workout.`);

    } catch (error) {
      console.error('Error adding exercise:', error);
      toast.error('Failed to add exercise', 'Please try again.');
    }
  };

  /**
   * Remove exercise from selected day
   */
  const removeExerciseFromDay = async (exerciseName: string) => {
    if (!selectedDay) return;

    try {
      const currentExercises = selectedDay.exercises_structured || selectedDay.exercises || [];
      const updatedExercises = currentExercises.filter((ex: any) =>
        (typeof ex === 'string' ? ex : ex.name) !== exerciseName
      );
      const updatedExercisesNames = updatedExercises.map((ex: any) =>
        typeof ex === 'string' ? ex : ex.name
      );

      const estimatedTime = calculateWorkoutTime(updatedExercises);

      // Update local state
      setDailyWorkouts(prev =>
        prev.map(workout =>
          workout.id === selectedDay.id
            ? {
              ...workout,
              exercises: updatedExercisesNames,
              exercises_structured: updatedExercises,
              estimated_time: estimatedTime
            }
            : workout
        )
      );

      // Update selected day
      setSelectedDay(prev => prev ? {
        ...prev,
        exercises: updatedExercisesNames,
        exercises_structured: updatedExercises,
        estimated_time: estimatedTime
      } : null);

      // Auto-save to database to prevent data loss
      await saveWorkoutExercises(selectedDay.id, updatedExercisesNames, updatedExercises, estimatedTime);

    } catch (error) {
      console.error('Error removing exercise:', error);
      toast.error('Failed to remove exercise', 'Please try again.');
    }
  };

  /**
   * Save workout exercises to database
   * Accepts explicit data parameters to avoid stale React state issues
   */
  const saveWorkoutExercises = async (
    workoutId: string,
    exercises: string[],
    exercisesStructured: any[],
    estimatedTime: number
  ) => {
    if (!session) return;

    try {
      const { error } = await supabase
        .from('daily_workouts')
        .update({
          exercises,
          exercises_structured: exercisesStructured,
          estimated_time: estimatedTime,
        })
        .eq('id', workoutId);

      if (error) {
        console.error('Error auto-saving exercises:', error);
      } else {
        console.log('Exercises auto-saved to Supabase');
      }
    } catch (error) {
      console.error('Error auto-saving exercises:', error);
    }
  };

  /**
   * Save changes and close modal
   */
  const saveChangesToDatabase = async () => {
    if (!selectedDay || !session) return;

    try {
      // Save current state (exercises are already auto-saved, but ensure latest state is persisted)
      await saveWorkoutExercises(
        selectedDay.id,
        selectedDay.exercises,
        selectedDay.exercises_structured || [],
        selectedDay.estimated_time
      );

      // Close modal
      setEditModalVisible(false);
      setSelectedDay(null);

      // Show confirmation
      setShowChangesApplied(true);
      setTimeout(() => setShowChangesApplied(false), 2000);

    } catch (error) {
      console.error('Error saving changes:', error);
      toast.error('Failed to save changes', 'Please try again.');
    }
  };

  /**
   * Calculate workout time based on exercises
   */
  const calculateWorkoutTime = (exercises: any[]): number => {
    let totalMinutes = 5; // Warmup/cooldown

    exercises.forEach(ex => {
      if (typeof ex === 'object' && ex.sets && ex.reps) {
        // Assume 3 seconds per rep average
        const repsAvg = typeof ex.reps === 'string'
          ? parseInt(ex.reps.split('-')[0])
          : ex.reps;

        const setTime = repsAvg * 3; // seconds
        const totalRestTime = (ex.sets - 1) * ex.rest_seconds;
        const exerciseTime = (ex.sets * setTime + totalRestTime) / 60;

        totalMinutes += exerciseTime;
      }
    });

    return Math.round(totalMinutes);
  };

  /**
   * Get unique body parts from exercises
   */
  const getUniqueBodyParts = (): string[] => {
    const bodyParts = new Set<string>();
    exerciseDatabase.forEach(exercise => {
      bodyParts.add(exercise.target);
      bodyParts.add(exercise.bodyPart);
    });
    return Array.from(bodyParts).sort();
  };

  /**
   * Get day name with proper capitalization
   */
  const getDayName = (dayOfWeek: string) => {
    return dayOfWeek.charAt(0).toUpperCase() + dayOfWeek.slice(1);
  };

  /**
   * Get body part icon
   */
  const getBodyPartIcon = (bodyPart: string): string => {
    const normalizedPart = bodyPart.toLowerCase();
    return BODY_PART_ICONS[normalizedPart] || BODY_PART_ICONS.general;
  };

  /**
   * Format plan name to be human readable
   */
  const formatPlanName = (name: string | undefined) => {
    if (!name) return '';
    // Remove 'plan' (case insensitive) and underscores
    const cleanName = name.replace(/_?plan/gi, '').replace(/_/g, ' ').trim();
    // Title Case
    return cleanName.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  /**
   * Render exercise item
   */
  const renderExerciseItem = ({ item }: { item: Exercise }) => {
    const gifUrl = item.gif_path ? getExerciseGifUrl(item.gif_path) : '';
    return (
      <TouchableOpacity
        style={[styles.exerciseItem, { backgroundColor: colors.backgroundTertiary, borderColor: colors.border }]}
        onPress={() => addExerciseToDay(item)}
      >
        <View style={styles.exerciseItemLeft}>
          <View style={[styles.exerciseThumb, { backgroundColor: colors.background, borderColor: colors.border }]}>
            {gifUrl ? (
              <Image source={{ uri: gifUrl }} style={styles.exerciseThumbImage} resizeMode="cover" />
            ) : (
              <Ionicons name={getBodyPartIcon(item.target) as any} size={22} color={colors.primary} />
            )}
          </View>
          <View style={styles.exerciseItemInfo}>
            <Text style={[styles.exerciseItemName, { color: colors.text }]} numberOfLines={1}>{formatExerciseName(item.name)}</Text>
            <Text style={[styles.exerciseItemDetails, { color: colors.textMuted }]} numberOfLines={1}>
              {toTitleCase(item.target)} • {toTitleCase(item.equipment)} • {toTitleCase(item.difficulty)}
            </Text>
          </View>
        </View>
        <Ionicons name="add-circle" size={26} color={colors.primary} />
      </TouchableOpacity>
    );
  };

  /**
   * Render current exercise item with swipe-to-delete
   */
  const renderCurrentExerciseItem = (exercise: any, index: number) => {
    const exerciseName = typeof exercise === 'string' ? exercise : exercise.name;
    const exerciseData = exerciseDatabase.find(ex => ex.name === exerciseName);

    const renderRightActions = () => (
      <TouchableOpacity
        style={styles.deleteAction}
        onPress={() => removeExerciseFromDay(exerciseName)}
      >
        <Ionicons name="trash" size={20} color="#fff" />
        <Text style={styles.deleteActionText}>Delete</Text>
      </TouchableOpacity>
    );

    const gifUrl = exerciseData?.gif_path ? getExerciseGifUrl(exerciseData.gif_path) : '';

    return (
      <Swipeable key={index} renderRightActions={renderRightActions}>
        <View style={[styles.currentExerciseItem, { backgroundColor: colors.backgroundTertiary }]}>
          <View style={[styles.exerciseThumb, { backgroundColor: colors.background, borderColor: colors.border }]}>
            {gifUrl ? (
              <Image source={{ uri: gifUrl }} style={styles.exerciseThumbImage} resizeMode="cover" />
            ) : (
              <Ionicons
                name={getBodyPartIcon(exerciseData?.target || 'general') as any}
                size={22}
                color={colors.primary}
              />
            )}
          </View>
          <View style={styles.currentExerciseItemInfo}>
            <Text style={[styles.currentExerciseItemName, { color: colors.text }]}>{formatExerciseName(exerciseName)}</Text>
            {typeof exercise === 'object' && (
              <Text style={[styles.currentExerciseItemSets, { color: colors.textMuted }]}>
                {exercise.sets}×{exercise.reps}
              </Text>
            )}
          </View>
        </View>
      </Swipeable>
    );
  };

  /**
   * Render a workout day card
   */
  const renderWorkoutDay = (workout: DailyWorkout, index: number) => {
    const assignedDay = dayAssignments[workout.day_of_week] || workout.day_of_week;
    const displayDay = assignedDay ? getDayName(assignedDay) : `Workout ${index + 1}`;

    // Determine primary muscle group for icon (based on split name or first exercise)
    const muscleGroup = workout.split_day_name.split(' ')[0] || 'general';

    return (
      <LinearGradient
        key={workout.id}
        colors={[colors.backgroundSecondary, colors.backgroundTertiary]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.workoutCard, { borderColor: colors.border }]}
      >

        <View style={styles.workoutHeader}>
          <View style={styles.workoutInfo}>
            <View style={styles.headerRow}>
              <Text style={[styles.dayName, { color: colors.text }]}>{displayDay}</Text>
            </View>
            <Text style={[styles.splitName, { color: colors.textMuted }]}>{toTitleCase(workout.split_day_name)}</Text>
          </View>
          <View style={styles.workoutStats}>
            <Text style={[styles.exerciseCount, { color: colors.text }]}>
              {(workout.exercises_structured || workout.exercises).length} exercises
            </Text>
            <Text style={[styles.duration, { color: colors.textMuted }]}>{workout.estimated_time} min</Text>
          </View>
        </View>

        {/* Day Assignment Picker */}
        <View style={[styles.dayAssignmentContainer, { borderTopColor: colors.border }]}>
          <Text style={[styles.dayAssignmentLabel, { color: colors.text }]}>Assign to day of week:</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayPickerContainer}>
            {DAYS_OF_WEEK.map((day) => {
              const isSelected = assignedDay === day;
              const isAssignedToOther = Object.keys(dayAssignments).some(
                key => key !== workout.day_of_week && dayAssignments[key] === day
              );

              return (
                <TouchableOpacity
                  key={day}
                  style={[
                    styles.dayPickerButton,
                    { backgroundColor: colors.backgroundTertiary, borderColor: colors.border },
                    isSelected && { backgroundColor: colors.primary, borderColor: colors.primary },
                    isAssignedToOther && !isSelected && { backgroundColor: colors.background, opacity: 0.3 }
                  ]}
                  onPress={() => handleDayAssignment(workout.day_of_week, day)}
                  disabled={isAssignedToOther && !isSelected}
                >
                  <Text style={[
                    styles.dayPickerButtonText,
                    { color: colors.textMuted },
                    isSelected && { color: colors.textInverse },
                    isAssignedToOther && !isSelected && { color: colors.textTertiary }
                  ]}>
                    {day.charAt(0).toUpperCase() + day.slice(1, 3)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        <View style={styles.exerciseList}>
          {(workout.exercises_structured || workout.exercises).map((exercise, index) => {
            if (typeof exercise === 'string') {
              return (
                <View key={index} style={styles.exerciseRow}>
                  <Text style={[styles.exerciseBullet, { color: colors.textMuted }]}>•</Text>
                  <Text style={[styles.exerciseItemNameText, { color: colors.text }]}>{formatExerciseName(exercise)}</Text>
                </View>
              );
            } else {
              return (
                <View key={index} style={styles.exerciseRow}>
                  <Text style={[styles.exerciseBullet, { color: colors.textMuted }]}>•</Text>
                  <Text style={[styles.exerciseItemNameText, { color: colors.text }]}>
                    {formatExerciseName(exercise.name)} <Text style={{ color: colors.textMuted }}>{exercise.sets}×{exercise.reps}</Text>
                  </Text>
                </View>
              );
            }
          })}
        </View>

        <View style={styles.actionButtonsContainer}>
          <TouchableOpacity
            style={[styles.editButton, { borderColor: colors.textMuted, backgroundColor: colors.backgroundTertiary }]}
            onPress={() => handleEditDay(workout)}
          >
            <Ionicons name="create-outline" size={16} color={colors.text} />
            <Text style={[styles.editButtonText, { color: colors.text }]}>Edit Exercises</Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>
    );
  };

  if (authLoading || dataLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.text }]}>Loading your workout plan...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>{userProfile?.name ? `${userProfile.name}'s` : 'Your'} Custom Plan</Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>
            Review and customize your personalized {formatPlanName(plan?.plan_name)} Plan
          </Text>
        </View>

        {/* Injury acknowledgment: users who flag an issue during setup need to
            SEE it was factored in, or they assume the AI ignored it. Guard
            against empty-ish serialized values ("[]", "{}", "null") — showing
            "Built around what you told us ([])" reads like a broken template. */}
        {userProfile?.injuries?.trim() &&
        !['[]', '{}', 'null', 'none'].includes(userProfile.injuries.trim().toLowerCase()) ? (
          <View style={[styles.injuryBanner, { backgroundColor: `${colors.primary}14`, borderColor: `${colors.primary}45` }]}>
            <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
            <Text style={[styles.injuryBannerText, { color: colors.text }]}>
              Built around what you told us ({userProfile.injuries}): risky movements were
              excluded, and affected exercises include modification cues.
            </Text>
          </View>
        ) : null}

        {/* Workout Days */}
        <View style={styles.workoutsContainer}>
          <Text style={[styles.workoutsTitle, { color: colors.text }]}>Your Workout Days</Text>
          <Text style={[styles.workoutsSubtitle, { color: colors.textMuted }]}>Assign each workout to a day of the week</Text>
          {dailyWorkouts.map((workout, index) => renderWorkoutDay(workout, index))}
        </View>

        {/* Confirmation Section */}
        <View style={[styles.confirmationContainer, { backgroundColor: colors.backgroundSecondary }]}>
          <Text style={[styles.confirmationTitle, { color: colors.text }]}>Ready to start?</Text>
          <Text style={[styles.confirmationText, { color: colors.textMuted }]}>
            Your personalized workout plan is ready. You can always make edits to your plan later.
          </Text>
        </View>
      </ScrollView>

      {/* Bottom Actions */}
      <View style={[styles.bottomActions, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.confirmButton, { backgroundColor: colors.text }, (confirming || !canConfirm) && styles.confirmButtonDisabled]}
          onPress={handleConfirmPlan}
          disabled={confirming || !canConfirm}
        >
          <Text style={[styles.confirmButtonText, { color: colors.textInverse }]}>
            {confirming ? 'Setting up...' : !canConfirm ? 'Loading…' : 'Start This Plan'}
          </Text>
          <Ionicons name="checkmark" size={20} color={colors.textInverse} />
        </TouchableOpacity>
      </View>

      {/* Exercise Editing Modal */}
      <Modal
        visible={editModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setEditModalVisible(false)}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <View style={[styles.modalOverlay, { backgroundColor: colors.background }]}>
            <View style={[styles.modalContent, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
              {/* Header */}
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: colors.text }]}>
                  Edit {toTitleCase(selectedDay?.split_day_name || '')} Workout
                </Text>
                <View style={styles.modalHeaderRight}>
                  <TouchableOpacity
                    onPress={() => setEditModalVisible(false)}
                    style={styles.closeButton}
                  >
                    <Ionicons name="close" size={28} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Search + Filters (above unified list) */}
              <View style={styles.searchSection}>
                <View style={[styles.searchInputWrapper, { backgroundColor: colors.backgroundTertiary, borderColor: colors.border }]}>
                  <Ionicons name="search" size={18} color={colors.textMuted} style={styles.searchIcon} />
                  <TextInput
                    style={[styles.searchInputText, { color: colors.text }]}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Search exercises..."
                    placeholderTextColor={colors.textMuted}
                  />
                  {searchQuery.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.searchClearBtn}>
                      <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.filterPillsRow}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent} style={styles.filterPillsScroll}>
                    <TouchableOpacity
                      style={[styles.filterButton, { backgroundColor: colors.backgroundTertiary, borderColor: colors.border }, selectedBodyPart === 'all' && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                      onPress={() => setSelectedBodyPart('all')}
                    >
                      <Text numberOfLines={1} style={[styles.filterButtonText, { color: colors.textMuted }, selectedBodyPart === 'all' && { color: colors.textInverse }]}>
                        All
                      </Text>
                    </TouchableOpacity>
                    {getUniqueBodyParts().map(bodyPart => (
                      <TouchableOpacity
                        key={bodyPart}
                        style={[styles.filterButton, { backgroundColor: colors.backgroundTertiary, borderColor: colors.border }, selectedBodyPart === bodyPart && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                        onPress={() => setSelectedBodyPart(bodyPart)}
                      >
                        <Text numberOfLines={1} style={[styles.filterButtonText, { color: colors.textMuted }, selectedBodyPart === bodyPart && { color: colors.textInverse }]}>
                          {toTitleCase(bodyPart)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  <TouchableOpacity
                    style={[styles.filtersTriggerButton, { backgroundColor: colors.backgroundTertiary, borderColor: selectedDifficulty !== 'all' ? colors.primary : colors.border }]}
                    onPress={() => setFiltersSheetVisible(true)}
                  >
                    <Ionicons name="options-outline" size={16} color={selectedDifficulty !== 'all' ? colors.primary : colors.text} />
                    <Text style={[styles.filtersTriggerText, { color: selectedDifficulty !== 'all' ? colors.primary : colors.text }]}>
                      Filters
                    </Text>
                    {selectedDifficulty !== 'all' && (
                      <View style={[styles.filtersDot, { backgroundColor: colors.primary }]} />
                    )}
                  </TouchableOpacity>
                </View>
              </View>

              {/* Unified list: selected at top, then available */}
              <View style={styles.exerciseListSection}>
                <FlatList
                  data={filteredExercises}
                  renderItem={renderExerciseItem}
                  keyExtractor={(item) => item.id}
                  style={styles.searchableExerciseList}
                  showsVerticalScrollIndicator={false}
                  initialNumToRender={20}
                  maxToRenderPerBatch={20}
                  ListHeaderComponent={
                    <View>
                      <View style={styles.unifiedSectionHeader}>
                        <Text style={[styles.unifiedSectionLabel, { color: colors.textMuted }]}>
                          YOUR EXERCISES
                        </Text>
                        <Text style={[styles.unifiedSectionCount, { color: colors.textMuted }]}>
                          {(selectedDay?.exercises_structured || selectedDay?.exercises || []).length}/15
                        </Text>
                      </View>
                      {(selectedDay?.exercises_structured || selectedDay?.exercises || []).length === 0 ? (
                        <View style={[styles.emptySelected, { borderColor: colors.border }]}>
                          <Text style={[styles.emptySelectedText, { color: colors.textMuted }]}>
                            No exercises yet — tap one below to add it.
                          </Text>
                        </View>
                      ) : (
                        (selectedDay?.exercises_structured || selectedDay?.exercises || []).map(renderCurrentExerciseItem)
                      )}
                      <View style={styles.unifiedSectionHeader}>
                        <Text style={[styles.unifiedSectionLabel, { color: colors.textMuted }]}>
                          ADD EXERCISES
                        </Text>
                        <Text style={[styles.unifiedSectionCount, { color: colors.textMuted }]}>
                          {filteredExercises.length} available
                        </Text>
                      </View>
                    </View>
                  }
                  windowSize={10}
                />
              </View>

              {/* Save Button */}
              <TouchableOpacity
                style={[styles.saveButton, { backgroundColor: colors.text }]}
                onPress={saveChangesToDatabase}
              >
                <Text style={[styles.saveButtonText, { color: colors.textInverse }]}>Save Changes</Text>
              </TouchableOpacity>
            </View>
          </View>
        </GestureHandlerRootView>
      </Modal>

      {/* Filters Bottom Sheet */}
      <Modal
        visible={filtersSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setFiltersSheetVisible(false)}
      >
        <TouchableOpacity
          style={styles.filtersSheetBackdrop}
          activeOpacity={1}
          onPress={() => setFiltersSheetVisible(false)}
        >
          <TouchableOpacity activeOpacity={1} style={[styles.filtersSheet, { backgroundColor: colors.backgroundSecondary }]}>
            <View style={[styles.filtersSheetHandle, { backgroundColor: colors.border }]} />
            <View style={styles.filtersSheetHeader}>
              <Text style={[styles.filtersSheetTitle, { color: colors.text }]}>Filters</Text>
              <TouchableOpacity onPress={() => setFiltersSheetVisible(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.filtersSheetLabel, { color: colors.textMuted }]}>Difficulty</Text>
            <View style={styles.filtersSheetOptions}>
              {['all', 'beginner', 'intermediate', 'expert'].map(difficulty => {
                const active = selectedDifficulty === difficulty;
                return (
                  <TouchableOpacity
                    key={difficulty}
                    style={[
                      styles.filtersSheetOption,
                      { backgroundColor: colors.backgroundTertiary, borderColor: colors.border },
                      active && { backgroundColor: colors.primary, borderColor: colors.primary },
                    ]}
                    onPress={() => setSelectedDifficulty(difficulty)}
                  >
                    <Text style={[styles.filtersSheetOptionText, { color: colors.text }, active && { color: colors.textInverse }]}>
                      {difficulty === 'all' ? 'Any' : toTitleCase(difficulty)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.filtersSheetActions}>
              <TouchableOpacity
                style={[styles.filtersSheetReset, { borderColor: colors.border }]}
                onPress={() => {
                  setSelectedDifficulty('all');
                  setSelectedBodyPart('all');
                }}
              >
                <Text style={[styles.filtersSheetResetText, { color: colors.text }]}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.filtersSheetApply, { backgroundColor: colors.text }]}
                onPress={() => setFiltersSheetVisible(false)}
              >
                <Text style={[styles.filtersSheetApplyText, { color: colors.textInverse }]}>Apply</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Changes Applied Confirmation */}
      {showChangesApplied && (
        <View style={[styles.changesAppliedOverlay, { backgroundColor: colors.background + 'CC' }]}>
          <View style={[styles.changesAppliedContainer, { backgroundColor: colors.backgroundSecondary, borderColor: colors.success }]}>
            <Ionicons name="checkmark-circle" size={32} color={colors.success} />
            <Text style={[styles.changesAppliedText, { color: colors.success }]}>Changes saved! ✓</Text>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 18,
    marginTop: 16,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 100,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  injuryBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 24,
  },
  injuryBannerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '500',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
  },
  workoutsContainer: {
    marginBottom: 32,
  },
  workoutsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  workoutsSubtitle: {
    fontSize: 14,
    marginBottom: 16,
  },
  workoutCard: {
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 5,
  },
  workoutHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  workoutInfo: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  dayName: {
    fontSize: 22,
    fontWeight: '800',
  },
  splitName: {
    fontSize: 16,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  workoutStats: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  exerciseCount: {
    fontSize: 12,
    marginBottom: 2,
  },
  duration: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  exerciseList: {
    marginBottom: 16,
  },
  exerciseRow: {
    flexDirection: 'row',
    marginBottom: 8,
    alignItems: 'flex-start',
  },
  exerciseBullet: {
    marginRight: 6,
    fontSize: 14,
  },
  exerciseItemNameText: {
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
  },
  moreExercises: {
    fontSize: 12,
    fontStyle: 'italic',
    paddingLeft: 12,
  },
  actionButtonsContainer: {
    marginTop: 16,
    gap: 12,
  },
  aiButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderWidth: 2,
    borderRadius: 12,
    shadowColor: '#2E90FA',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  aiButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  aiButtonText: {
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 8,
  },
  premiumBadge: {
    backgroundColor: '#2E90FA',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  premiumText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#000',
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderWidth: 1.5,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  editButtonText: {
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
  dayAssignmentContainer: {
    marginTop: 16,
    marginBottom: 16,
    paddingTop: 16,
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.02)',
  },
  dayAssignmentLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  dayPickerContainer: {
    flexDirection: 'row',
    gap: 4,
    paddingBottom: 2,
  },
  dayPickerButton: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1.5,
    minWidth: 48,
    alignItems: 'center',
    marginRight: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  dayPickerButtonSelected: {
  },
  dayPickerButtonDisabled: {
    opacity: 0.3,
  },
  dayPickerButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  dayPickerButtonTextSelected: {
  },
  dayPickerButtonTextDisabled: {
  },
  confirmationContainer: {
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  confirmationTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 12,
    textAlign: 'center',
  },
  confirmationText: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  bottomActions: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 20,
    borderTopWidth: 1,
  },
  confirmButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 5,
  },
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmButtonText: {
    fontSize: 18,
    fontWeight: 'bold',
    marginRight: 8,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    paddingTop: 20,
    width: '100%',
    height: '95%',
    borderWidth: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 28,
    fontWeight: '800',
    flex: 1,
    letterSpacing: -0.3,
  },
  modalHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  aiHeaderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2E90FA20',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#2E90FA',
    gap: 8,
  },
  aiHeaderButtonText: {
    color: '#2E90FA',
    fontSize: 12,
    fontWeight: '700',
  },
  closeButton: {
    padding: 4,
  },
  // Current exercises section
  currentExercisesSection: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  currentExercisesList: {
    maxHeight: 200,
    borderRadius: 16,
    padding: 8,
  },
  currentExerciseItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  currentExerciseItemInfo: {
    flex: 1,
    marginLeft: 12,
  },
  currentExerciseItemName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  currentExerciseItemSets: {
    fontSize: 12,
  },
  deleteAction: {
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    borderRadius: 8,
    marginBottom: 4,
  },
  deleteActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  // Search and filters
  searchSection: {
    marginBottom: 20,
  },
  searchInput: {
    borderRadius: 16,
    padding: 16,
    fontSize: 16,
    marginBottom: 12,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  filterRow: {
    marginBottom: 12,
  },
  filterScrollContent: {
    paddingRight: 16,
  },
  filterButton: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginRight: 8,
    borderWidth: 1.5,
    maxWidth: 150,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  filterButtonActive: {
  },
  filterButtonText: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  filterButtonTextActive: {
  },
  difficultyFilter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  difficultyButton: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    flex: 1,
    marginHorizontal: 2,
  },
  difficultyButtonActive: {
  },
  difficultyButtonText: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  difficultyButtonTextActive: {
  },
  // Exercise list section
  exerciseListSection: {
    flex: 1,
    marginBottom: 20,
  },
  searchableExerciseList: {
    flex: 1,
  },
  exerciseItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  exerciseItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  exerciseItemInfo: {
    marginLeft: 12,
    flex: 1,
  },
  exerciseItemName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  exerciseItemDetails: {
    fontSize: 12,
  },
  // Save button
  saveButton: {
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  // Changes applied confirmation
  changesAppliedOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  changesAppliedContainer: {
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
  },
  changesAppliedText: {
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 12,
  },
  // Search input wrapper with icon
  searchInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInputText: {
    flex: 1,
    paddingVertical: 16,
    fontSize: 16,
  },
  searchClearBtn: {
    padding: 4,
  },
  // Filter pills row + filters trigger
  filterPillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  filterPillsScroll: {
    flex: 1,
  },
  filtersTriggerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginLeft: 8,
    gap: 8,
  },
  filtersTriggerText: {
    fontSize: 13,
    fontWeight: '600',
  },
  filtersDot: {
    width: 6,
    height: 6,
    borderRadius: 4,
  },
  // Exercise list thumbnail
  exerciseThumb: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  exerciseThumbImage: {
    width: '100%',
    height: '100%',
  },
  // Filters bottom sheet
  filtersSheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  filtersSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
  },
  filtersSheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 4,
    marginBottom: 12,
  },
  filtersSheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  filtersSheetTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  filtersSheetLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 12,
  },
  filtersSheetOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 24,
  },
  filtersSheetOption: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  filtersSheetOptionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  filtersSheetActions: {
    flexDirection: 'row',
    gap: 12,
  },
  filtersSheetReset: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  filtersSheetResetText: {
    fontSize: 15,
    fontWeight: '600',
  },
  filtersSheetApply: {
    flex: 2,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  filtersSheetApplyText: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  // Unified list section headers
  unifiedSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 4,
    paddingBottom: 12,
  },
  unifiedSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  unifiedSectionCount: {
    fontSize: 11,
    fontWeight: '600',
  },
  emptySelected: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  emptySelectedText: {
    fontSize: 13,
  },
});
