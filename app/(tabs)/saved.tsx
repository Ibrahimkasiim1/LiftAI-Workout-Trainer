// app/(tabs)/saved.tsx
/**
 * Saved Workouts Tab
 * 
 * Route: /(tabs)/saved (hidden from tab bar)
 * Function: Personal workout collection and management
 * 
 * Features:
 * - Display all user-saved workout plans in scrollable list
 * - View detailed workout information and exercise breakdowns
 * - Start saved workouts directly from the collection
 * - Delete unwanted saved workouts
 * - Quick access to workout details and modifications
 * - Integration with main workout system
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Import storage utilities
import AdBanner from '../../components/AdBanner';
import FirstVisitHint from '../../components/FirstVisitHint';
import EmptyState from '../../components/ui/EmptyState';
import { theme } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { SkeletonList } from '../../components/ui/Skeleton';
import { toast } from '../../components/ui/Toast';
import { deleteWorkout, getActiveWorkoutSession, getSavedWorkouts, SavedWorkout } from '../../utils/storage';

export default function SavedWorkoutsScreen() {
  const { isDark } = useTheme();
  const [savedWorkouts, setSavedWorkouts] = useState<SavedWorkout[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSession, setActiveSession] = useState<any | null>(null);
  const router = useRouter();

  // Load saved workouts and active session on component mount
  useEffect(() => {
    loadSavedWorkouts();
    loadActiveSession();
  }, []);

  // Reload workouts when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      console.log('Saved Workouts screen focused - reloading data');
      loadSavedWorkouts();
      loadActiveSession();
    }, [])
  );

  /**
   * Load active workout session
   */
  const loadActiveSession = useCallback(async () => {
    try {
      const session = await getActiveWorkoutSession();
      setActiveSession(session);
    } catch (error) {
      console.error('Error loading active session:', error);
      setActiveSession(null);
    }
  }, []);

  /**
   * Load all saved workouts from Supabase
   */
  const loadSavedWorkouts = useCallback(async () => {
    try {
      setLoading(true);
      console.log('Loading saved workouts from Supabase...');

      const { workouts } = await getSavedWorkouts();
      setSavedWorkouts(workouts);

      console.log('Loaded', workouts.length, 'saved workouts from Supabase');
    } catch (error) {
      console.error('Error loading saved workouts:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Start a saved workout
   * Navigates to the workout screen with the exercise list
   * If there's an active session for this workout, resumes it
   */
  const startWorkout = useCallback((workout: SavedWorkout) => {
    console.log('Starting saved workout:', workout.workoutName);

    // Check if there's an active session for this workout
    const hasActiveSession = activeSession &&
      (activeSession.workoutId === workout.id || activeSession.workoutName === workout.workoutName);

    if (hasActiveSession) {
      console.log('Resuming active workout session');
      router.push({
        pathname: '/workout',
        params: {
          exercises: JSON.stringify(activeSession.exercises),
          exerciseStructure: JSON.stringify(activeSession.structuredExercises || []),
          exerciseNames: JSON.stringify(activeSession.exercises),
          workoutName: activeSession.workoutName,
          estimatedTime: String(activeSession.estimatedTime || 0),
          difficulty: workout.difficulty || 'personalized',
          workoutType: activeSession.workoutType || 'saved_workout',
          sessionId: activeSession.id
        }
      });
    } else {
      // Start fresh workout
      router.push({
        pathname: '/workout',
        params: {
          exercises: JSON.stringify(workout.exercises),
          exerciseStructure: JSON.stringify(workout.exercises_structured || []),
          exerciseNames: JSON.stringify(workout.exercises),
          workoutName: workout.workoutName,
          estimatedTime: workout.estimatedTime.toString(),
          difficulty: workout.difficulty || 'personalized',
          workoutType: 'saved_workout',
          workoutId: workout.id
        }
      });
    }
  }, [router, activeSession]);

  /**
   * Delete a saved workout with confirmation
   */
  const handleDeleteWorkout = useCallback(async (workout: SavedWorkout) => {
    const ok = await confirmSheet({
      title: 'Delete Workout',
      message: `Are you sure you want to delete "${workout.workoutName}"?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteWorkout(workout.id);
      setSavedWorkouts(prev => prev.filter(w => w.id !== workout.id));
      toast.success('Workout deleted');
    } catch (error) {
      console.error('Error deleting workout:', error);
      toast.error('Failed to delete workout', 'Please try again.');
    }
  }, []);

  /**
   * Format date for display
   */
  const formatDate = (date?: Date) => {
    if (!date) return 'Recently added';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  /**
   * Render individual workout card
   */
  const renderWorkoutCard = ({ item: workout }: { item: SavedWorkout }) => (
    <View style={styles.workoutCard}>
      {/* Workout Header — paywall workout-card pattern: bold title + muted
          meta line instead of icon-per-stat rows. */}
      <View style={styles.workoutHeader}>
        <Text style={styles.workoutName}>{workout.workoutName}</Text>
        <Text style={styles.workoutDate}>{formatDate(workout.createdAt)}</Text>
      </View>
      <Text style={styles.workoutMeta}>
        {workout.estimatedTime} min · {workout.exercises.length} exercises · {workout.difficulty}
      </Text>

      {/* Exercise preview — soft inset rows */}
      {workout.exercises.length > 0 && (
        <View style={styles.exerciseRows}>
          {workout.exercises.slice(0, 3).map((name, i) => (
            <View key={`${name}-${i}`} style={styles.exerciseRow}>
              <Text style={styles.exerciseRowText} numberOfLines={1}>{name}</Text>
            </View>
          ))}
          {workout.exercises.length > 3 && (
            <Text style={styles.exerciseRowMore}>
              +{workout.exercises.length - 3} more
            </Text>
          )}
        </View>
      )}

      {/* Workout Description */}
      {workout.description && (
        <Text style={styles.workoutDescription}>{workout.description}</Text>
      )}

      {/* Action Buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity
          style={styles.startButton}
          onPress={() => startWorkout(workout)}
        >
          <Ionicons
            name={activeSession && (activeSession.workoutId === workout.id || activeSession.workoutName === workout.workoutName) ? "play-circle" : "play"}
            size={20}
            color={theme.colors.textInverse}
          />
          <Text style={styles.startButtonText}>
            {activeSession && (activeSession.workoutId === workout.id || activeSession.workoutName === workout.workoutName)
              ? 'Continue Workout'
              : 'Start Workout'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.deleteButton}
          onPress={() => handleDeleteWorkout(workout)}
        >
          <Ionicons name="trash-outline" size={20} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );

  /**
   * Render empty state when no workouts are saved
   */
  const renderEmptyState = () => (
    <EmptyState
      icon="bookmark-outline"
      headline="No Saved Workouts"
      sub="Create a workout with the AI assistant and it will be automatically saved here."
      actionLabel="Create Workout"
      onAction={() => router.push('/(tabs)/chat')}
      style={styles.emptyState}
    />
  );

  /** Dashed ghost row (paywall workout-card CTA) below the list. */
  const renderListFooter = () => (
    <TouchableOpacity
      style={styles.generateRow}
      onPress={() => router.push('/(tabs)/chat')}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel="Generate a new workout"
    >
      <Ionicons name="add" size={15} color="#5AA6FF" />
      <Text style={styles.generateRowText}>Generate a new workout</Text>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <SkeletonList isDark={isDark} rows={5} rowHeight={92} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Saved Workouts</Text>
        <Text style={styles.headerSubtitle}>
          {savedWorkouts.length} workout{savedWorkouts.length !== 1 ? 's' : ''} saved
        </Text>
      </View>

      {/* One-time orientation hint (first visit only) */}
      <FirstVisitHint
        hintKey="saved"
        text="Workouts you build with the coach land here — reuse any of them with one tap."
      />

      {/* Free-tier banner (no-op for Pro) — browsing saved workouts is a
          low-effort surface, safe for a banner per the ads placement rules. */}
      <AdBanner />

      {/* Workouts List */}
      {savedWorkouts.length === 0 ? (
        renderEmptyState()
      ) : (
        <FlatList
          data={savedWorkouts}
          keyExtractor={(item) => item.id}
          renderItem={renderWorkoutCard}
          ListFooterComponent={renderListFooter}
          contentContainerStyle={styles.listContainer}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: theme.colors.text,
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.regular,
  },
  header: {
    padding: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    color: theme.colors.text,
    fontSize: theme.typography.fontSize['3xl'],
    fontFamily: theme.typography.fontFamily.bold,
    marginBottom: 4,
  },
  headerSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.regular,
  },
  listContainer: {
    padding: 20,
    paddingTop: 12,
  },
  workoutCard: {
    backgroundColor: theme.colors.backgroundSecondary,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  workoutHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  workoutName: {
    color: theme.colors.text,
    fontSize: theme.typography.fontSize.xl,
    fontFamily: theme.typography.fontFamily.bold,
    flex: 1,
    marginRight: 10,
  },
  workoutDate: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.regular,
  },
  // Paywall workout-card pattern: muted meta line + soft inset exercise rows.
  workoutMeta: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontFamily: theme.typography.fontFamily.medium,
    marginBottom: 12,
  },
  exerciseRows: {
    gap: 8,
    marginBottom: 14,
  },
  exerciseRow: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  exerciseRowText: {
    color: theme.colors.text,
    fontSize: 13,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  exerciseRowMore: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontFamily: theme.typography.fontFamily.medium,
    paddingLeft: 4,
  },
  generateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.22)',
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 4,
  },
  generateRowText: {
    color: '#5AA6FF',
    fontSize: 13,
    fontFamily: theme.typography.fontFamily.semiBold,
  },
  workoutDescription: {
    color: theme.colors.textSecondary,
    fontSize: theme.typography.fontSize.sm,
    fontFamily: theme.typography.fontFamily.regular,
    lineHeight: 20,
    marginBottom: 16,
  },
  actionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Mono CTA per design system (blue stays for accents only).
  startButton: {
    backgroundColor: theme.colors.text,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    flex: 1,
    marginRight: 10,
  },
  startButtonText: {
    color: theme.colors.textInverse,
    fontSize: theme.typography.fontSize.base,
    fontFamily: theme.typography.fontFamily.bold,
    marginLeft: 5,
  },
  deleteButton: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
  },
});
