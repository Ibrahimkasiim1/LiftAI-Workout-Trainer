// app/exercise-detail.tsx
/**
 * Exercise Detail Screen
 * 
 * Route: /exercise-detail
 * Function: Display detailed exercise history with sets and analytics
 * 
 * Features:
 * - Tabbed interface (Sets / Analyze)
 * - Lists all sets grouped by date
 * - Weight progression chart
 * - Edit set functionality with bottom sheet
 */

import { Ionicons } from '@expo/vector-icons';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LineChart } from 'react-native-gifted-charts';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors, theme } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { toast } from '../../components/ui/Toast';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import {
  ExercisePerformanceLog,
  ExerciseSeriesPoint,
  ExerciseSummary,
  getExerciseDetailSeries,
  getExerciseHistory,
  getExerciseSummary,
  getPersonalRecords,
  PersonalRecords
} from '../../src/services/ProgressService';
import { getLocalDateString } from '../../utils/date';
import { supabase } from '../../utils/supabase';
import { formatExerciseName } from '../../utils/exerciseName';

const { width: screenWidth } = Dimensions.get('window');
const chartWidth = screenWidth - 40;

export default function ExerciseDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  // Raw name (matches the DB / history); format only for display.
  const exerciseName = params.exerciseName as string;
  const displayExerciseName = formatExerciseName(exerciseName);
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const { session, loading: authLoading } = useRequireAuth();

  const editSetBottomSheetRef = useRef<BottomSheet>(null);

  const [dataLoading, setDataLoading] = useState(true);
  const [exerciseHistory, setExerciseHistory] = useState<ExercisePerformanceLog[]>([]);
  const [exerciseSummary, setExerciseSummary] = useState<ExerciseSummary | null>(null);
  const [personalRecords, setPersonalRecords] = useState<PersonalRecords | null>(null);
  const [activeTab, setActiveTab] = useState<'sets' | 'analyze'>('sets');
  const [analyzeFilter, setAnalyzeFilter] = useState<'lifetime' | 'last2'>('lifetime');
  const [analyzeMetric, setAnalyzeMetric] = useState<'oneRm' | 'volume'>('oneRm');
  const [seriesAll, setSeriesAll] = useState<ExerciseSeriesPoint[]>([]);

  // Edit set state
  const [editingSet, setEditingSet] = useState<ExercisePerformanceLog | null>(null);
  const [editWeight, setEditWeight] = useState('');
  const [editReps, setEditReps] = useState('');
  const [editComment, setEditComment] = useState('');
  const [saving, setSaving] = useState(false);

  /**
   * Load exercise details
   */
  const loadExerciseDetails = useCallback(async () => {
    if (!exerciseName || !session) return;

    try {
      setDataLoading(true);
      console.log('Loading details for:', exerciseName);

      const userId = session.user.id;

      // Load exercise data in parallel
      const [historyResult, summaryResult, recordsResult, seriesResult] = await Promise.all([
        getExerciseHistory(userId, exerciseName, 20),
        getExerciseSummary(userId, exerciseName),
        getPersonalRecords(userId, exerciseName),
        getExerciseDetailSeries(userId, exerciseName, 60),
      ]);

      if (historyResult.history) {
        setExerciseHistory(historyResult.history);
      }

      if (summaryResult.summary) {
        setExerciseSummary(summaryResult.summary);
      }

      if (recordsResult.records) {
        setPersonalRecords(recordsResult.records);
      }

      setSeriesAll(seriesResult);
    } catch (error) {
      console.error('Error loading exercise details:', error);
    } finally {
      setDataLoading(false);
    }
  }, [exerciseName, session]);

  useEffect(() => {
    if (!authLoading && session) {
      loadExerciseDetails();
    }
  }, [loadExerciseDetails, authLoading, session]);

  /**
   * Format date for chart labels
   */
  const formatDateForChart = (date: Date): string => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  };


  /**
   * Group exercise history by workout date
   */
  const groupHistoryByDate = (history: ExercisePerformanceLog[]) => {
    const grouped = new Map<string, ExercisePerformanceLog[]>();

    history.forEach(entry => {
      const dateKey = getLocalDateString(entry.workout_date); // local day, not UTC
      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, []);
      }
      grouped.get(dateKey)!.push(entry);
    });

    // Convert to array and sort by date (most recent first)
    return Array.from(grouped.entries())
      .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
      .map(([date, sets]) => ({
        date: new Date(date),
        sets: sets.sort((a, b) => a.set_number - b.set_number)
      }));
  };

  /**
   * Get day name from date
   */
  const getDayName = (date: Date): string => {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  };

  /**
   * Open edit set bottom sheet
   */
  const openEditSet = (set: ExercisePerformanceLog) => {
    setEditingSet(set);
    setEditWeight(set.weight_used.toString());
    setEditReps(set.reps_completed.toString());
    setEditComment(''); // Will load from database if exists

    // Load comment from database
    loadSetComment(set.id!);

    editSetBottomSheetRef.current?.expand();
  };

  /**
   * Load comment for a set
   */
  const loadSetComment = async (setId: string) => {
    try {
      const { data, error } = await supabase
        .from('exercise_performance')
        .select('comment')
        .eq('id', setId)
        .single();

      if (!error && data) {
        setEditComment(data.comment || '');
      }
    } catch (error) {
      console.error('Error loading comment:', error);
    }
  };

  /**
   * Save edited set
   */
  const handleSaveSet = async () => {
    if (!editingSet || !editingSet.id) return;

    const weightNum = parseFloat(editWeight);
    const repsNum = parseInt(editReps);

    if (isNaN(weightNum) || weightNum < 0) {
      toast.error('Invalid weight', 'Please enter a valid weight value.');
      return;
    }

    if (isNaN(repsNum) || repsNum < 1) {
      toast.error('Invalid reps', 'Please enter a valid number of reps.');
      return;
    }

    try {
      setSaving(true);

      const { error } = await supabase
        .from('exercise_performance')
        .update({
          weight_used: weightNum,
          reps_completed: repsNum,
          comment: editComment.trim() || null,
        })
        .eq('id', editingSet.id);

      if (error) {
        toast.error('Failed to save changes');
        return;
      }

      // Reload exercise details
      await loadExerciseDetails();

      // Close bottom sheet
      editSetBottomSheetRef.current?.close();

      toast.success('Set updated');
    } catch (error) {
      console.error('Error saving set:', error);
      toast.error('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Delete set
   */
  const handleDeleteSet = async () => {
    if (!editingSet || !editingSet.id) return;

    const ok = await confirmSheet({
      title: 'Delete Set',
      message: 'Are you sure you want to delete this set? This action cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    try {
      const { error } = await supabase
        .from('exercise_performance')
        .delete()
        .eq('id', editingSet.id || '');

      if (error) {
        toast.error('Failed to delete set');
        return;
      }

      // Reload exercise details
      await loadExerciseDetails();

      // Close bottom sheet
      editSetBottomSheetRef.current?.close();
    } catch (error) {
      console.error('Error deleting set:', error);
      toast.error('Failed to delete set');
    }
  };

  if (authLoading || dataLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{displayExerciseName}</Text>
          <View style={styles.backButton} />
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.loadingText, { color: colors.text }]}>Loading exercise data...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!exerciseSummary || !personalRecords) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{displayExerciseName}</Text>
          <View style={styles.backButton} />
        </View>
        <View style={styles.emptyState}>
          <Text style={[styles.emptyStateText, { color: colors.text }]}>No data available</Text>
        </View>
      </SafeAreaView>
    );
  }

  const groupedHistory = groupHistoryByDate(exerciseHistory);

  // Filter analyze series by toggle
  const filteredSeries = analyzeFilter === 'last2' ? seriesAll.slice(-2) : seriesAll;
  const isBodyweight = filteredSeries.length > 0 && filteredSeries.every(p => p.isBodyweight);
  const metricKey = analyzeMetric;
  const metricLabel = isBodyweight
    ? 'Reps'
    : metricKey === 'oneRm'
      ? 'Est. 1RM (kg)'
      : 'Volume (kg)';

  const chartData = filteredSeries.map(p => ({
    value: p[metricKey],
    label: formatDateForChart(new Date(p.date)),
    labelTextStyle: { color: colors.textMuted, fontSize: 9 },
    customDataPoint: () => null,
  }));

  const chartMax = chartData.length > 0 ? Math.max(...chartData.map(d => d.value)) : 1;
  const chartMin = chartData.length > 0 ? Math.min(...chartData.map(d => d.value)) : 0;
  const yPad = (chartMax - chartMin) * 0.15 || 1;

  const maxWeight = personalRecords.max_weight;

  return (
    <GestureHandlerRootView style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Header with Back Button */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{displayExerciseName}</Text>
          <View style={styles.backButton} />
        </View>

        {/* Tab Switcher */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tab, { backgroundColor: colors.backgroundSecondary }, activeTab === 'sets' && { backgroundColor: colors.primary }]}
            onPress={() => setActiveTab('sets')}
          >
            <Text style={[styles.tabText, { color: colors.textMuted }, activeTab === 'sets' && { color: colors.textInverse }]}>
              Sets
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, { backgroundColor: colors.backgroundSecondary }, activeTab === 'analyze' && { backgroundColor: colors.primary }]}
            onPress={() => setActiveTab('analyze')}
          >
            <Text style={[styles.tabText, { color: colors.textMuted }, activeTab === 'analyze' && { color: colors.textInverse }]}>
              Analyze
            </Text>
          </TouchableOpacity>
        </View>

        {/* Tab Content */}
        {activeTab === 'sets' ? (
          // Sets Tab
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {groupedHistory.map((group, groupIndex) => (
              <View key={group.date.toISOString()} style={styles.dateGroup}>
                <Text style={[styles.dateHeader, { color: colors.text }]}>{getDayName(group.date)}</Text>
                <Text style={[styles.dateSubheader, { color: colors.textMuted }]}>
                  {group.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </Text>
                {group.sets.map((set, setIndex) => {
                  // Calculate weight difference for first set only
                  let weightDiff = null;
                  if (groupIndex === 0 && setIndex === 0 && groupedHistory.length > 1) {
                    const prevGroup = groupedHistory[1];
                    if (prevGroup && prevGroup.sets.length > 0) {
                      weightDiff = set.weight_used - prevGroup.sets[0].weight_used;
                    }
                  }

                  return (
                    <TouchableOpacity
                      key={set.id}
                      style={[styles.setItem, { backgroundColor: colors.backgroundSecondary }]}
                      onPress={() => openEditSet(set)}
                    >
                      <View style={styles.setInfo}>
                        <Text style={[styles.setNumber, { color: colors.textMuted }]}>Set {set.set_number}</Text>
                        <View style={styles.setDetails}>
                          <Text style={[styles.setWeight, { color: colors.text }]}>{set.weight_used} kg</Text>
                          <Text style={[styles.setReps, { color: colors.textSecondary }]}>× {set.reps_completed} reps</Text>
                          {weightDiff !== null && weightDiff !== 0 && (
                            <Text style={[styles.weightDiff, weightDiff > 0 ? { color: colors.success } : { color: colors.error }]}>
                              {weightDiff > 0 ? '+' : ''}{weightDiff} kg
                            </Text>
                          )}
                        </View>
                      </View>
                      <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        ) : (
          // Analyze Tab
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {/* Max Weight Display */}
            <View style={[styles.maxWeightContainer, { backgroundColor: colors.backgroundSecondary }]}>
              <Text style={[styles.maxWeightLabel, { color: colors.textMuted }]}>Max Weight</Text>
              <Text style={[styles.maxWeightValue, { color: colors.primary }]}>{maxWeight} kg</Text>
            </View>

            {/* Metric toggle: 1RM vs Volume (hidden for bodyweight-only) */}
            {!isBodyweight && (
              <View style={styles.filterContainer}>
                <TouchableOpacity
                  style={[styles.filterButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }, analyzeMetric === 'oneRm' && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={() => setAnalyzeMetric('oneRm')}
                >
                  <Text style={[styles.filterButtonText, { color: colors.textMuted }, analyzeMetric === 'oneRm' && { color: colors.textInverse }]}>
                    Est. 1RM
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.filterButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }, analyzeMetric === 'volume' && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                  onPress={() => setAnalyzeMetric('volume')}
                >
                  <Text style={[styles.filterButtonText, { color: colors.textMuted }, analyzeMetric === 'volume' && { color: colors.textInverse }]}>
                    Volume
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Bezier chart with gradient fill + scrubber */}
            {chartData.length >= 2 ? (
              <View style={[styles.section, { backgroundColor: colors.backgroundSecondary, borderRadius: 16, padding: 12, paddingTop: 20 }]}>
                <Text style={{ fontSize: 12, color: colors.textMuted, fontFamily: theme.typography.fontFamily.semiBold, marginBottom: 8, marginLeft: 8 }}>
                  {metricLabel}
                </Text>
                <LineChart
                  data={chartData}
                  width={chartWidth - 30}
                  height={200}
                  curved
                  areaChart
                  thickness={3}
                  color={colors.primary}
                  startFillColor={colors.primary}
                  endFillColor={colors.primary}
                  startOpacity={0.45}
                  endOpacity={0.02}
                  hideDataPoints
                  hideRules
                  yAxisColor="transparent"
                  xAxisColor={colors.border}
                  yAxisTextStyle={{ color: colors.textMuted, fontSize: 10 }}
                  xAxisLabelTextStyle={{ color: colors.textMuted, fontSize: 9 }}
                  initialSpacing={10}
                  endSpacing={10}
                  spacing={Math.max(20, (chartWidth - 60) / Math.max(1, chartData.length - 1))}
                  noOfSections={4}
                  maxValue={chartMax + yPad}
                  yAxisOffset={Math.max(0, chartMin - yPad)}
                  adjustToWidth
                  disableScroll
                  pointerConfig={{
                    pointerStripUptoDataPoint: true,
                    pointerStripColor: colors.primary,
                    pointerStripWidth: 2,
                    pointerColor: colors.primary,
                    radius: 6,
                    pointerLabelWidth: 110,
                    pointerLabelHeight: 50,
                    activatePointersOnLongPress: false,
                    autoAdjustPointerLabelPosition: true,
                    pointerLabelComponent: (items: any[]) => {
                      const item = items?.[0];
                      if (!item) return null;
                      return (
                        <View
                          style={{
                            backgroundColor: colors.background,
                            borderColor: colors.primary,
                            borderWidth: 1,
                            borderRadius: 12,
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                          }}
                        >
                          <Text style={{ color: colors.text, fontFamily: theme.typography.fontFamily.bold, fontSize: 14 }}>
                            {Number(item.value).toFixed(isBodyweight ? 0 : 1)}
                          </Text>
                          <Text style={{ color: colors.textMuted, fontSize: 10 }}>{item.label}</Text>
                        </View>
                      );
                    },
                  }}
                />
              </View>
            ) : (
              <View style={[styles.section, { paddingVertical: 32, alignItems: 'center' }]}>
                <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                  Log at least 2 workouts of this exercise to see a chart.
                </Text>
              </View>
            )}

            {/* Range filter */}
            <View style={styles.filterContainer}>
              <TouchableOpacity
                style={[styles.filterButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }, analyzeFilter === 'lifetime' && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                onPress={() => setAnalyzeFilter('lifetime')}
              >
                <Text style={[styles.filterButtonText, { color: colors.textMuted }, analyzeFilter === 'lifetime' && { color: colors.textInverse }]}>
                  Lifetime
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.filterButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }, analyzeFilter === 'last2' && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                onPress={() => setAnalyzeFilter('last2')}
              >
                <Text style={[styles.filterButtonText, { color: colors.textMuted }, analyzeFilter === 'last2' && { color: colors.textInverse }]}>
                  Last 2 Sessions
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        )}

        {/* Edit Set Bottom Sheet */}
        <BottomSheet
          ref={editSetBottomSheetRef}
          index={-1}
          snapPoints={['70%', '90%']}
          enablePanDownToClose={true}
          backgroundStyle={[styles.editSheetBackground, { backgroundColor: colors.background }]}
          handleIndicatorStyle={[styles.editSheetIndicator, { backgroundColor: colors.border }]}
        >
          <BottomSheetScrollView style={styles.editSheetContent}>
            {editingSet && (
              <>
                {/* Header */}
                <View style={styles.editSheetHeader}>
                  <Text style={[styles.editSheetTitle, { color: colors.text }]}>Edit Set</Text>
                  <TouchableOpacity
                    onPress={() => editSetBottomSheetRef.current?.close()}
                    style={styles.editCloseButton}
                  >
                    <Ionicons name="close" size={24} color={colors.text} />
                  </TouchableOpacity>
                </View>

                {/* Exercise Info */}
                <View style={[styles.editExerciseInfo, { backgroundColor: colors.backgroundSecondary, borderColor: colors.border }]}>
                  <Text style={[styles.editExerciseName, { color: colors.text }]}>{editingSet.exercise_name}</Text>
                  <Text style={[styles.editExerciseSubtitle, { color: colors.textMuted }]}>
                    Set {editingSet.set_number} • {getDayName(editingSet.workout_date)}, {editingSet.workout_date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                </View>

                {/* Weight Input */}
                <View style={styles.editInputSection}>
                  <Text style={[styles.editInputLabel, { color: colors.text }]}>Weight (kg)</Text>
                  <TextInput
                    style={[styles.editInput, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
                    value={editWeight}
                    onChangeText={setEditWeight}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                  />
                </View>

                {/* Reps Input */}
                <View style={styles.editInputSection}>
                  <Text style={[styles.editInputLabel, { color: colors.text }]}>Reps</Text>
                  <TextInput
                    style={[styles.editInput, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
                    value={editReps}
                    onChangeText={setEditReps}
                    keyboardType="number-pad"
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                  />
                </View>

                {/* Comment Input */}
                <View style={styles.editInputSection}>
                  <Text style={[styles.editInputLabel, { color: colors.text }]}>Comment (optional)</Text>
                  <TextInput
                    style={[styles.editInput, styles.editCommentInput, { backgroundColor: colors.backgroundSecondary, color: colors.text, borderColor: colors.border }]}
                    value={editComment}
                    onChangeText={setEditComment}
                    placeholder="Add a note about this set..."
                    placeholderTextColor={colors.textMuted}
                    multiline
                    numberOfLines={4}
                    textAlignVertical="top"
                  />
                </View>

                {/* Action Buttons */}
                <View style={styles.editActionsContainer}>
                  <TouchableOpacity
                    style={[styles.editSaveButton, { backgroundColor: colors.text }, saving && styles.editButtonDisabled]}
                    onPress={handleSaveSet}
                    disabled={saving}
                  >
                    {saving ? (
                      <ActivityIndicator color={colors.textInverse} />
                    ) : (
                      <>
                        <Ionicons name="checkmark" size={20} color={colors.textInverse} />
                        <Text style={[styles.editSaveButtonText, { color: colors.textInverse }]}>Save Changes</Text>
                      </>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.editDeleteButton, { backgroundColor: colors.backgroundSecondary, borderColor: colors.error }]}
                    onPress={handleDeleteSet}
                  >
                    <Ionicons name="trash-outline" size={20} color={colors.error} />
                    <Text style={[styles.editDeleteButtonText, { color: colors.error }]}>Delete Set</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </BottomSheetScrollView>
        </BottomSheet>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontFamily: theme.typography.fontFamily.bold,
    textAlign: 'center',
    marginHorizontal: 12,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    marginTop: 16,
    fontFamily: theme.typography.fontFamily.regular,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 16,
    fontFamily: theme.typography.fontFamily.regular,
  },
  tabContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 12,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  tabText: {
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    padding: 20,
  },
  section: {
    marginBottom: 24,
  },
  dateGroup: {
    marginBottom: 24,
  },
  dateHeader: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  dateSubheader: {
    fontSize: 14,
    marginBottom: 12,
  },
  setItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  setInfo: {
    flex: 1,
  },
  setNumber: {
    fontSize: 14,
    marginBottom: 4,
  },
  setDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  setWeight: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  setReps: {
    fontSize: 16,
  },
  weightDiff: {
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
  weightDiffPositive: {
  },
  weightDiffNegative: {
  },
  maxWeightContainer: {
    alignItems: 'center',
    padding: 20,
    borderRadius: 12,
    marginBottom: 20,
  },
  maxWeightLabel: {
    fontSize: 14,
    marginBottom: 8,
  },
  maxWeightValue: {
    fontSize: 36,
    fontWeight: 'bold',
  },
  filterContainer: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
    marginBottom: 20,
  },
  filterButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
  },
  filterButtonActive: {
  },
  filterButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  filterButtonTextActive: {
  },
  chart: {
    marginVertical: 8,
    borderRadius: 16,
  },
  editSheetBackground: {
  },
  editSheetIndicator: {
  },
  editSheetContent: {
    padding: 24,
  },
  editSheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  editSheetTitle: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  editCloseButton: {
    padding: 4,
  },
  editExerciseInfo: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
    borderWidth: 1,
  },
  editExerciseName: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  editExerciseSubtitle: {
    fontSize: 14,
  },
  editInputSection: {
    marginBottom: 20,
  },
  editInputLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  editInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
  },
  editCommentInput: {
    height: 100,
    paddingTop: 16,
  },
  editActionsContainer: {
    gap: 12,
    marginTop: 8,
  },
  editSaveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    gap: 8,
  },
  editSaveButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  editDeleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  editDeleteButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  editButtonDisabled: {
    opacity: 0.5,
  },
});

