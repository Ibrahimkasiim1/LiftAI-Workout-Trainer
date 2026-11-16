// app/day-detail.tsx
/**
 * Day Detail Screen
 * 
 * Route: /day-detail
 * Function: Detailed workout day view with exercise breakdown
 * 
 * Features:
 * - Complete workout day details with exercises
 * - Sets, reps, and rest period information
 * - Target muscle group visualization
 * - Body part icon mapping for easy identification
 * - Exercise structure and progression details
 * - Integration with workout plan system
 * - Navigation from plan review or main app
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { ExerciseDetail } from '../../types';
import { formatExerciseName } from '../../utils/exerciseName';
import { getExerciseGifUrl } from '../../utils/exerciseGifs';
import { getSession, supabase } from '../../utils/supabase';
import {
  bodyPartsFromExercises,
  fetchCooldown,
  fetchWarmup,
  type PhaseExercise,
} from '../../utils/warmupCooldown';
// Complete mapping for all 19 body parts
const BODY_PART_ICONS: { [key: string]: string } = {
  // Upper Body
  'pectorals': 'body-outline',        // Chest
  'lats': 'fitness-outline',          // Back wings
  'upper back': 'fitness-outline',    // Upper back
  'delts': 'radio-button-on-outline', // Shoulders (round)
  'traps': 'triangle-outline',        // Traps (trapezoid)
  'biceps': 'trending-up-outline',    // Biceps (flex)
  'triceps': 'trending-down-outline', // Triceps (extend)
  'forearms': 'hand-left-outline',    // Forearms

  // Core
  'abs': 'grid-outline',              // Abs (six-pack grid)
  'serratus anterior': 'reorder-three-outline', // Side abs
  'spine': 'remove-outline',          // Spine (straight line)

  // Lower Body
  'glutes': 'ellipse-outline',        // Glutes (round)
  'quads': 'pause-outline',           // Quads (vertical bars)
  'hamstrings': 'reorder-two-outline', // Hamstrings
  'calves': 'footsteps-outline',      // Calves
  'adductors': 'arrow-down-outline',  // Inner thigh
  'abductors': 'arrow-up-outline',    // Outer thigh

  // Special
  'cardiovascular system': 'heart-outline', // Cardio
  'levator scapulae': 'triangle-outline',   // Neck/shoulder

  // Fallbacks
  'chest': 'body-outline',
  'back': 'fitness-outline',
  'shoulders': 'radio-button-on-outline',
  'arms': 'trending-up-outline',
  'legs': 'walk-outline',
  'core': 'grid-outline',
  'cardio': 'heart-outline',
  'general': 'fitness-outline'
};

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

interface DayDetailProps {
  dayId: string;
  dayName: string;
  exercises: string;
}

/**
 * Collapsible, optional warmup/cooldown block. Collapsed by default for
 * experienced users (tap to expand = do it, ignore = skip) but EXPANDED by
 * default for beginners — they're the ones who need the guidance and never
 * think to tap an "optional" accordion. These are suggestions only — not
 * logged sets.
 */
function PhaseSection({
  title,
  subtitle,
  icon,
  items,
  colors,
  initialOpen = false,
}: {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  items: PhaseExercise[];
  colors: ReturnType<typeof getThemeColors>;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [userToggled, setUserToggled] = useState(false);
  // `initialOpen` resolves async (profile fetch) — honor it until the user
  // interacts, then their choice wins.
  useEffect(() => {
    if (!userToggled) setOpen(initialOpen);
  }, [initialOpen, userToggled]);
  if (items.length === 0) return null;
  return (
    <View style={[styles.phaseCard, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
      <TouchableOpacity
        style={styles.phaseHeader}
        onPress={() => {
          setUserToggled(true);
          setOpen((v) => !v);
        }}
        activeOpacity={0.7}
      >
        <Ionicons name={icon} size={20} color={colors.primary} />
        <View style={styles.phaseHeaderText}>
          <Text style={[styles.phaseTitle, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.phaseSubtitle, { color: colors.textMuted }]}>
            {open ? subtitle : `${items.length} moves · optional — tap to show`}
          </Text>
        </View>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {open ? (
        <View style={styles.phaseList}>
          {items.map((it) => (
            <View key={it.id} style={styles.phaseRow}>
              <View style={[styles.phaseThumb, { backgroundColor: colors.backgroundTertiary }]}>
                {it.gif_path ? (
                  <Image source={{ uri: getExerciseGifUrl(it.gif_path) }} style={styles.phaseThumbImg} resizeMode="cover" />
                ) : (
                  <Ionicons name="body-outline" size={18} color={colors.textMuted} />
                )}
              </View>
              <Text style={[styles.phaseRowName, { color: colors.text }]} numberOfLines={1}>
                {formatExerciseName(it.name)}
              </Text>
              <Text style={[styles.phaseRowDuration, { color: colors.textMuted }]}>
                {icon === 'walk-outline' ? '30-45s' : 'Hold 30s'}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function DayDetailScreen() {
  const [exercises, setExercises] = useState<ExerciseDetail[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [workoutName, setWorkoutName] = useState('');
  const [estimatedTime, setEstimatedTime] = useState(0);
  const [warmup, setWarmup] = useState<PhaseExercise[]>([]);
  const [cooldown, setCooldown] = useState<PhaseExercise[]>([]);
  /** Beginners get the warm-up/cool-down sections expanded by default. */
  const [isBeginner, setIsBeginner] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await getSession();
        if (!session?.user?.id) return;
        const { data } = await supabase
          .from('user_profiles')
          .select('fitness_level')
          .eq('id', session.user.id)
          .maybeSingle();
        if (!cancelled && data?.fitness_level === 'beginner') setIsBeginner(true);
      } catch {
        // Non-fatal: sections just stay collapsed.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const router = useRouter();
  const params = useLocalSearchParams();
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const { session, loading: authLoading } = useRequireAuth();

  useEffect(() => {
    if (!authLoading && session) {
      loadDayDetails();
    }
  }, [authLoading, session]);

  /**
   * Load day details from database
   */
  const loadDayDetails = async () => {
    try {
      setDataLoading(true);

      // Get workout details from URL params
      const dayId = params.dayId as string;
      const dayName = params.dayName as string;
      const exercisesParam = params.exercises as string;

      if (exercisesParam) {
        try {
          const parsedExercises = JSON.parse(exercisesParam);
          setExercises(parsedExercises);
          setWorkoutName(dayName);

          // Region-matched warmup (mobility) + cooldown (stretching) suggestions.
          // Best-effort: failures just leave the optional sections empty.
          const bodyParts = bodyPartsFromExercises(parsedExercises);
          Promise.all([fetchWarmup(bodyParts), fetchCooldown(bodyParts)])
            .then(([w, c]) => {
              setWarmup(w);
              setCooldown(c);
            })
            .catch((e) => console.warn('warmup/cooldown fetch failed:', e));

          // Calculate estimated time if not provided
          const totalTime = parsedExercises.reduce((total: number, ex: ExerciseDetail) => {
            const repsAvg = typeof ex.reps === 'string'
              ? parseInt(ex.reps.split('-')[0])
              : (ex.reps ?? 10);
            const setTime = repsAvg * 3; // seconds
            const sets = ex.sets ?? 3;
            const restSeconds = ex.rest_seconds ?? 90;
            const totalRestTime = (sets - 1) * restSeconds;
            return total + (sets * setTime + totalRestTime) / 60;
          }, 5); // 5 min warmup/cooldown

          setEstimatedTime(Math.round(totalTime));
        } catch (error) {
          console.error('Error parsing exercises:', error);
        }
      }
    } catch (error) {
      console.error('Error loading day details:', error);
    } finally {
      setDataLoading(false);
    }
  };


  /**
   * Get body part icon
   */
  const getBodyPartIcon = (bodyPart: string): string => {
    const normalizedPart = bodyPart.toLowerCase();
    return BODY_PART_ICONS[normalizedPart] || BODY_PART_ICONS.general;
  };

  /**
   * Format reps display
   */
  const formatReps = (reps: number | string): string => {
    return typeof reps === 'string' ? reps : reps.toString();
  };

  /**
   * Format rest time
   */
  const formatRestTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  };

  if (authLoading || dataLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.text }]}>Loading workout details...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.back()}
          >
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>

          <View style={styles.headerContent}>
            <Text style={[styles.workoutTitle, { color: colors.text }]}>{workoutName}</Text>
            <Text style={[styles.workoutTime, { color: colors.textMuted }]}>⏱️ {estimatedTime} minutes</Text>
          </View>
        </View>

        {/* Warm-up (optional, collapsed by default) */}
        <View style={styles.phaseContainer}>
          <PhaseSection
            title="Warm-up"
            subtitle="Dynamic mobility to prep the muscles you're about to train"
            icon="walk-outline"
            items={warmup}
            colors={colors}
            initialOpen={isBeginner}
          />
        </View>

        {/* Exercise List */}
        <View style={styles.exercisesContainer}>
          <Text style={[styles.exercisesTitle, { color: colors.text }]}>Exercises ({exercises.length})</Text>

          {exercises.map((exercise, index) => (
            <View key={index} style={[styles.exerciseCard, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
              <View style={styles.exerciseHeader}>
                <View style={styles.exerciseInfo}>
                  <Text style={[styles.exerciseName, { color: colors.text }]}>{formatExerciseName(exercise.name)}</Text>
                  <View style={styles.exerciseDetails}>
                    <View style={styles.detailItem}>
                      <Ionicons
                        name={getBodyPartIcon(exercise.body_part ?? 'general') as any}
                        size={16}
                        color={colors.primary}
                      />
                      <Text style={[styles.detailText, { color: colors.primary }]}>{toTitleCase(exercise.target_muscle ?? 'general')}</Text>
                    </View>
                  </View>
                </View>

                <View style={styles.exerciseStats}>
                  <Text style={[styles.setsReps, { color: colors.text }]}>
                    {exercise.sets ?? 3} × {formatReps(exercise.reps ?? '8-12')}
                  </Text>
                  <Text style={[styles.restTime, { color: colors.textMuted }]}>
                    Rest: {formatRestTime(exercise.rest_seconds ?? 90)}
                  </Text>
                </View>
              </View>
              {exercise.injury_note ? (
                <View style={[styles.injuryNoteRow, { backgroundColor: `${colors.primary}14` }]}>
                  <Ionicons name="shield-checkmark" size={14} color={colors.primary} />
                  <Text style={[styles.injuryNoteText, { color: colors.primary }]}>
                    {exercise.injury_note}
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>

        {/* Cool-down (optional, collapsed by default) */}
        <View style={styles.phaseContainer}>
          <PhaseSection
            title="Cool-down"
            subtitle="Static stretches for the muscles you just worked"
            icon="leaf-outline"
            items={cooldown}
            colors={colors}
            initialOpen={isBeginner}
          />
        </View>

      </ScrollView>
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
    fontSize: 16,
    marginTop: 16,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 100,
  },
  phaseContainer: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  phaseCard: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  phaseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  phaseHeaderText: { flex: 1 },
  phaseTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 15 },
  phaseSubtitle: { fontFamily: 'Montserrat_500Medium', fontSize: 12, marginTop: 2 },
  phaseList: { paddingHorizontal: 16, paddingBottom: 8 },
  phaseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  phaseThumb: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  phaseThumbImg: { width: '100%', height: '100%' },
  phaseRowName: { flex: 1, fontFamily: 'Montserrat_600SemiBold', fontSize: 14 },
  phaseRowDuration: { fontFamily: 'Montserrat_500Medium', fontSize: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 20,
    borderBottomWidth: 1,
  },
  backButton: {
    marginRight: 16,
    padding: 8,
  },
  headerContent: {
    flex: 1,
  },
  workoutTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  workoutTime: {
    fontSize: 16,
  },
  exercisesContainer: {
    padding: 20,
  },
  exercisesTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  exerciseCard: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
  },
  injuryNoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  injuryNoteText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  exerciseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  exerciseInfo: {
    flex: 1,
    marginRight: 16,
  },
  exerciseName: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  exerciseDetails: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 16,
  },
  detailText: {
    fontSize: 14,
    fontWeight: '500',
    marginLeft: 4,
    textTransform: 'capitalize',
  },
  exerciseStats: {
    alignItems: 'flex-end',
  },
  setsReps: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  restTime: {
    fontSize: 14,
  },
});
