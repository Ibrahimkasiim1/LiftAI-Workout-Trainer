/**
 * Edit Day — manual workout editor for one plan day.
 *
 * Route: /workout/edit-day?dayOfWeek=monday
 *
 * The no-chat-needed editing surface:
 *   • swipe an exercise LEFT → Replace (search picker) or Remove
 *   • long-press the handle → drag to reorder
 *   • tap the sets chip → stepper to change set count
 *   • "+ Add exercise" → full library search picker
 *   • rest day → empty state with "Add exercises" (turns the rest day into a
 *     training day) and "Move a workout here" (opens the week editor)
 *
 * Every change writes straight to `daily_workouts` (RLS: user owns the plan),
 * so the plan the chat coach reads and the plan the user edits are the same
 * rows — no sync layer.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import ExerciseSearchSheet, { type ExerciseRow } from '../../components/ExerciseSearchSheet';
import NumberStepperSheet from '../../components/NumberStepperSheet';
import { confirmSheet } from '../../components/ui/ConfirmSheet';
import { toast } from '../../components/ui/Toast';
import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { useProGate } from '../../hooks/useProGate';
import { useRequireAuth } from '../../hooks/useRequireAuth';
import { getExerciseGifUrl } from '../../utils/exerciseGifs';
import { formatExerciseName } from '../../utils/exerciseName';
import { supabase } from '../../utils/supabase';

interface PlanExercise {
  id?: string;
  name: string;
  sets?: number;
  reps?: string | number;
  rest_seconds?: number;
  gif_path?: string | null;
  target_muscle?: string | null;
  body_part?: string | null;
  equipment?: string | null;
  instructions?: string[] | null;
  [key: string]: unknown;
}

const DAY_LABELS: Record<string, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
  friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

/** Rough session length: reps×3s per set + rest between sets, +5 min buffer. */
function estimateMinutes(exercises: PlanExercise[]): number {
  const total = exercises.reduce((sum, ex) => {
    const repsAvg = typeof ex.reps === 'string' ? parseInt(ex.reps.split('-')[0], 10) || 10 : (ex.reps ?? 10);
    const sets = ex.sets ?? 3;
    const rest = ex.rest_seconds ?? 90;
    return sum + (sets * repsAvg * 3 + (sets - 1) * rest) / 60;
  }, 5);
  return Math.max(10, Math.round(total));
}

export default function EditDayScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const dayOfWeek = String(params.dayOfWeek ?? '').toLowerCase();
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const { session, loading: authLoading } = useRequireAuth();
  // Manual plan editing is Pro-only. Free users can OPEN the editor and see
  // their day (page-level gates hide value); every edit ACTION gates instead,
  // presenting the contextual paywall at the moment of intent.
  const proGate = useProGate();

  const [loading, setLoading] = useState(true);
  const [planId, setPlanId] = useState<string | null>(null);
  const [rowId, setRowId] = useState<string | null>(null);
  const [splitName, setSplitName] = useState('Workout');
  const [exercises, setExercises] = useState<PlanExercise[]>([]);
  const [saving, setSaving] = useState(false);

  // Picker state: 'add' appends; a number replaces that index.
  const [pickerMode, setPickerMode] = useState<'add' | number | null>(null);
  // Sets stepper: index of the exercise being edited.
  const [setsEditIndex, setSetsEditIndex] = useState<number | null>(null);
  const openSwipeable = useRef<Swipeable | null>(null);

  const load = useCallback(async () => {
    if (!session?.user?.id || !dayOfWeek) return;
    setLoading(true);
    try {
      const { data: plan } = await supabase
        .from('workout_plans')
        .select('id')
        .eq('user_id', session.user.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!plan) {
        toast.error('No active plan found');
        router.back();
        return;
      }
      setPlanId(plan.id);

      const { data: day } = await supabase
        .from('daily_workouts')
        .select('id, split_day_name, exercises_structured')
        .eq('plan_id', plan.id)
        .eq('day_of_week', dayOfWeek)
        .maybeSingle();

      if (day) {
        setRowId(day.id);
        setSplitName(day.split_day_name || 'Workout');
        setExercises(Array.isArray(day.exercises_structured) ? (day.exercises_structured as PlanExercise[]) : []);
      } else {
        setRowId(null);
        setSplitName('Custom Workout');
        setExercises([]);
      }
    } catch (e) {
      console.error('edit-day load failed:', e);
      toast.error('Could not load this day');
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id, dayOfWeek, router]);

  useEffect(() => {
    if (!authLoading && session) load();
  }, [authLoading, session, load]);

  /**
   * Persist the given list. Creates the daily_workouts row on first save for
   * a rest day; deletes it when the last exercise is removed (back to rest).
   */
  const persist = useCallback(
    async (next: PlanExercise[], focusLabel?: string) => {
      if (!planId) return;
      setSaving(true);
      try {
        const names = next.map((e) => e.name);
        if (next.length === 0 && rowId) {
          const { error } = await supabase.from('daily_workouts').delete().eq('id', rowId);
          if (error) throw error;
          setRowId(null);
          return;
        }
        if (rowId) {
          // `supabase as any`: generated types model exercises_structured as
          // Json — matching how other screens cast for this column.
          const { error } = await (supabase as any)
            .from('daily_workouts')
            .update({
              exercises_structured: next,
              exercises: names,
              estimated_time: estimateMinutes(next),
              ...(focusLabel ? { split_day_name: focusLabel } : {}),
            })
            .eq('id', rowId);
          if (error) throw error;
        } else if (next.length > 0) {
          const { data, error } = await (supabase as any)
            .from('daily_workouts')
            .insert({
              plan_id: planId,
              day_of_week: dayOfWeek,
              split_day_name: focusLabel ?? splitName ?? 'Custom Workout',
              exercises_structured: next,
              exercises: names,
              estimated_time: estimateMinutes(next),
            })
            .select('id')
            .single();
          if (error) throw error;
          setRowId((data as { id?: string } | null)?.id ?? null);
        }
      } catch (e) {
        console.error('edit-day persist failed:', e);
        toast.error("Couldn't save — check your connection");
        // Reload from source of truth so the UI never lies about saved state.
        void load();
      } finally {
        setSaving(false);
      }
    },
    [planId, rowId, dayOfWeek, splitName, load],
  );

  const applyChange = useCallback(
    (next: PlanExercise[]) => {
      // Backstop for every mutation path (incl. drag-reorder, which can't be
      // gated at gesture start): not applying the change makes the draggable
      // list snap back to the source-of-truth order.
      if (!proGate.isPro) {
        proGate.showPaywall('manual_edit');
        return;
      }
      setExercises(next);
      void persist(next);
    },
    [persist, proGate],
  );

  const pickerRowToExercise = (row: ExerciseRow, base?: PlanExercise): PlanExercise => ({
    id: row.id,
    name: row.name,
    target_muscle: row.target_muscle,
    body_part: row.body_part,
    equipment: row.equipment,
    gif_path: row.gif_path,
    instructions: row.instructions,
    sets: base?.sets ?? 3,
    reps: base?.reps ?? '8-12',
    rest_seconds: base?.rest_seconds ?? 90,
  });

  const handlePickerSelect = (row: ExerciseRow) => {
    const mode = pickerMode;
    setPickerMode(null);
    if (mode === null) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (mode === 'add') {
      applyChange([...exercises, pickerRowToExercise(row)]);
      toast.success(`Added ${formatExerciseName(row.name)}`);
    } else {
      const next = exercises.slice();
      next[mode] = pickerRowToExercise(row, exercises[mode]);
      applyChange(next);
      toast.success(`Replaced with ${formatExerciseName(row.name)}`);
    }
  };

  const handleRemove = async (index: number) => {
    openSwipeable.current?.close();
    const ex = exercises[index];
    const ok = await confirmSheet({
      title: `Remove ${formatExerciseName(ex.name)}?`,
      message:
        exercises.length === 1
          ? 'This is the last exercise — removing it makes this a rest day.'
          : 'It will be removed from this day of your plan.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    applyChange(exercises.filter((_, i) => i !== index));
  };

  const renderSwipeActions = (index: number) => (
    <View style={styles.swipeActions}>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: colors.primary }]}
        onPress={() => {
          openSwipeable.current?.close();
          proGate.gate('manual_edit', () => setPickerMode(index));
        }}
      >
        <Ionicons name="swap-horizontal" size={18} color="#FFF" />
        <Text style={styles.swipeActionText}>Replace</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.swipeAction, { backgroundColor: '#E5484D' }]}
        onPress={() => proGate.gate('manual_edit', () => handleRemove(index))}
      >
        <Ionicons name="trash-outline" size={18} color="#FFF" />
        <Text style={styles.swipeActionText}>Remove</Text>
      </TouchableOpacity>
    </View>
  );

  const renderItem = ({ item, drag, isActive, getIndex }: RenderItemParams<PlanExercise>) => {
    const index = getIndex() ?? 0;
    return (
      <Swipeable
        ref={(ref) => {
          // Track the currently-open row so actions can close it.
          if (ref) openSwipeable.current = ref;
        }}
        renderRightActions={() => renderSwipeActions(index)}
        overshootRight={false}
        enabled={!isActive}
      >
        <View
          style={[
            styles.row,
            { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
            isActive && { borderColor: colors.primary },
          ]}
        >
          <TouchableOpacity onLongPress={drag} delayLongPress={150} hitSlop={{ left: 8, right: 8 }}>
            <Ionicons name="reorder-three-outline" size={22} color={colors.textMuted} />
          </TouchableOpacity>

          <View style={[styles.thumb, { backgroundColor: colors.backgroundTertiary }]}>
            {item.gif_path ? (
              <Image source={{ uri: getExerciseGifUrl(item.gif_path) ?? undefined }} style={styles.thumbImg} resizeMode="cover" />
            ) : (
              <Ionicons name="barbell-outline" size={18} color={colors.textMuted} />
            )}
          </View>

          <View style={styles.rowText}>
            <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
              {formatExerciseName(item.name)}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.textMuted }]} numberOfLines={1}>
              {item.target_muscle ?? item.body_part ?? ''}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.setsChip, { borderColor: colors.border }]}
            onPress={() => proGate.gate('manual_edit', () => setSetsEditIndex(index))}
            accessibilityLabel="Change sets"
          >
            <Text style={[styles.setsChipText, { color: colors.text }]}>
              {item.sets ?? 3} × {typeof item.reps === 'number' ? item.reps : (item.reps ?? '8-12')}
            </Text>
          </TouchableOpacity>
        </View>
      </Swipeable>
    );
  };

  const dayLabel = DAY_LABELS[dayOfWeek] ?? dayOfWeek;

  if (authLoading || loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Edit {dayLabel}</Text>
            <Text style={[styles.headerSubtitle, { color: colors.textMuted }]}>
              {exercises.length > 0 ? `${splitName} · ${exercises.length} exercises` : 'Rest day'}
              {saving ? '  ·  Saving…' : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.weekBtn, { borderColor: colors.border }]}
            onPress={() => router.push('/workout/edit-week' as any)}
            accessibilityLabel="Edit whole week"
          >
            <Ionicons name="calendar-outline" size={16} color={colors.text} />
            <Text style={[styles.weekBtnText, { color: colors.text }]}>Week</Text>
          </TouchableOpacity>
        </View>

        {exercises.length === 0 ? (
          /* Rest day / empty state */
          <View style={styles.emptyWrap}>
            <View style={[styles.emptyIcon, { backgroundColor: isDark ? 'rgba(46,144,250,0.12)' : '#EAF3FF' }]}>
              <Ionicons name="bed-outline" size={30} color={colors.primary} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>{dayLabel} is a rest day</Text>
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>
              Want to train instead? Add exercises here, or move one of your existing workouts onto this day.
            </Text>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: colors.text }]}
              onPress={() => proGate.gate('manual_edit', () => setPickerMode('add'))}
            >
              <Ionicons name="add" size={18} color={colors.textInverse} />
              <Text style={[styles.primaryBtnText, { color: colors.textInverse }]}>Add exercises</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              onPress={() => router.push('/workout/edit-week' as any)}
            >
              <Ionicons name="swap-vertical" size={16} color={colors.text} />
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Move a workout here</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={[styles.hint, { color: colors.textMuted }]}>
              Swipe left to replace or remove · hold ≡ to reorder · tap sets to adjust
            </Text>
            <DraggableFlatList
              data={exercises}
              keyExtractor={(item, index) => `${item.id ?? item.name}-${index}`}
              renderItem={renderItem}
              onDragEnd={({ data }) => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                applyChange(data);
              }}
              containerStyle={{ flex: 1 }}
              contentContainerStyle={styles.listContent}
            />
            <View style={styles.footer}>
              <TouchableOpacity
                style={[styles.addBtn, { borderColor: colors.border, backgroundColor: colors.backgroundSecondary }]}
                onPress={() => proGate.gate('manual_edit', () => setPickerMode('add'))}
              >
                <Ionicons name="add" size={18} color={colors.primary} />
                <Text style={[styles.addBtnText, { color: colors.primary }]}>Add exercise</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Exercise picker (replace / add) */}
        <ExerciseSearchSheet
          visible={pickerMode !== null}
          onClose={() => setPickerMode(null)}
          onSelect={handlePickerSelect}
          selectLabel={pickerMode === 'add' ? 'Add to this day' : 'Replace with this'}
        />

        {/* Sets stepper */}
        <NumberStepperSheet
          visible={setsEditIndex !== null}
          value={setsEditIndex !== null ? exercises[setsEditIndex]?.sets ?? 3 : 3}
          label={
            setsEditIndex !== null && exercises[setsEditIndex]
              ? `Sets — ${formatExerciseName(exercises[setsEditIndex].name)}`
              : 'Sets'
          }
          unit="sets"
          min={1}
          max={10}
          step={1}
          onConfirm={(value) => {
            if (setsEditIndex === null) return;
            const next = exercises.slice();
            next[setsEditIndex] = { ...next[setsEditIndex], sets: value };
            setSetsEditIndex(null);
            applyChange(next);
          }}
          onClose={() => setSetsEditIndex(null)}
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    gap: 8,
  },
  backBtn: { padding: 4 },
  headerText: { flex: 1 },
  headerTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 19 },
  headerSubtitle: { fontFamily: 'Montserrat_500Medium', fontSize: 12, marginTop: 2 },
  weekBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  weekBtnText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 13 },

  hint: {
    fontFamily: 'Montserrat_500Medium',
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 10,
  },
  listContent: { paddingHorizontal: 16, paddingBottom: 12 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImg: { width: '100%', height: '100%' },
  rowText: { flex: 1, gap: 2 },
  rowName: { fontFamily: 'Montserrat_600SemiBold', fontSize: 14 },
  rowMeta: { fontFamily: 'Montserrat_500Medium', fontSize: 11, textTransform: 'capitalize' },
  setsChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  setsChipText: { fontFamily: 'Montserrat_700Bold', fontSize: 12, fontVariant: ['tabular-nums'] },

  swipeActions: { flexDirection: 'row', alignItems: 'stretch', marginBottom: 10 },
  swipeAction: {
    width: 84,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: 14,
    marginLeft: 8,
  },
  swipeActionText: { color: '#FFF', fontFamily: 'Montserrat_600SemiBold', fontSize: 11 },

  footer: { paddingHorizontal: 16, paddingVertical: 10 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 13,
  },
  addBtnText: { fontFamily: 'Montserrat_700Bold', fontSize: 14 },

  emptyWrap: { flex: 1, alignItems: 'center', paddingTop: 60, paddingHorizontal: 32, gap: 12 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { fontFamily: 'Montserrat_700Bold', fontSize: 18 },
  emptyText: { fontFamily: 'Montserrat_500Medium', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 28,
    marginTop: 8,
    alignSelf: 'stretch',
  },
  primaryBtnText: { fontFamily: 'Montserrat_700Bold', fontSize: 15 },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 13,
    alignSelf: 'stretch',
  },
  secondaryBtnText: { fontFamily: 'Montserrat_600SemiBold', fontSize: 14 },
});
