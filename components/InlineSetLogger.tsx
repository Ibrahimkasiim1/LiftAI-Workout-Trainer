/**
 * InlineSetLogger — compact set logger wrapper.
 *
 *   • Shows ONLY the most recent completed set as a repeat row (tap the
 *     Repeat pill to duplicate it in one action).
 *   • Below it, the ActiveSetEditor (prefilled from that previous set).
 *   • Session controls: "+ Add set" and "Finish exercise early" — the plan's
 *     set count is a default, not a cage.
 *   • "All sets logged" trophy state when the user finishes.
 *
 * No Swipeable here on purpose: the sheet already sits inside a BottomSheet
 * inside a paging FlatList, and a third gesture layer made taps unreliable.
 * The Repeat pill covers the duplicate action.
 *
 * Touchables use react-native-gesture-handler because the host is a gorhom
 * BottomSheetScrollView (v5) — standard react-native Pressable does not
 * reliably register taps inside it.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import type { ExercisePerformanceLog } from '../src/services/ProgressService';
import type { SetRecommendation } from '../src/services/progressiveOverload';
import ActiveSetEditor, { type EquipmentType } from './setLogger/ActiveSetEditor';

interface Props {
  totalSets: number;
  currentSet: number;
  completedSets: ExercisePerformanceLog[];
  recommendations: SetRecommendation[];
  equipmentType: EquipmentType;
  unit: 'kg' | 'lbs';
  weightStep: number;
  minWeight: number;
  maxWeight: number;
  plates: readonly number[];
  barWeight: number;
  onCompleteSet: (setNumber: number, weight: number, reps: number) => void;
  /** Adds one planned set to this exercise (mid-workout deviation). */
  onAddSet?: () => void;
  /** Marks the exercise complete with the sets logged so far. */
  onEndExerciseEarly?: () => void;
}

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(n.toString().split('.')[1]?.length === 1 ? 1 : 2);
};

export default function InlineSetLogger({
  totalSets,
  currentSet,
  completedSets,
  recommendations,
  equipmentType,
  unit,
  weightStep,
  plates,
  barWeight,
  onCompleteSet,
  onAddSet,
  onEndExerciseEarly,
}: Props) {
  const allDone = completedSets.length >= totalSets;

  // Most recently completed set (by highest set number).
  const previousSet =
    completedSets.length > 0
      ? completedSets.slice().sort((a, b) => b.set_number - a.set_number)[0]
      : undefined;

  // Fallback recommendation only used when no previous set exists.
  const fallbackRec = recommendations.find((r) => r.setNumber === currentSet);

  const duplicateSet = (s: ExercisePerformanceLog) => {
    // Selection (not success) feedback — the success haptic fires in the
    // parent only after the save is confirmed written.
    Haptics.selectionAsync();
    onCompleteSet(currentSet, s.weight_used, s.reps_completed);
  };

  return (
    <View style={styles.wrap}>
      {previousSet && !allDone && (
        <View style={styles.prevRow}>
          <Ionicons name="checkmark-circle" size={14} color="#2E90FA" />
          <Text style={styles.prevLabel}>Last</Text>
          <View style={styles.prevValues}>
            {equipmentType !== 'none' && (
              <Text style={styles.prevValueText}>
                {fmt(previousSet.weight_used)} {unit}
              </Text>
            )}
            <Text style={styles.prevMul}>×</Text>
            <Text style={styles.prevValueText}>{previousSet.reps_completed}</Text>
          </View>
          <TouchableOpacity
            onPress={() => duplicateSet(previousSet)}
            style={styles.repeatBtn}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Repeat last set"
          >
            <Ionicons name="repeat" size={13} color="#1A6FE0" />
            <Text style={styles.repeatBtnText}>Repeat</Text>
          </TouchableOpacity>
        </View>
      )}

      {!allDone ? (
        <ActiveSetEditor
          setNumber={currentSet}
          totalSets={totalSets}
          previousSet={previousSet}
          fallbackRecommendation={fallbackRec}
          equipmentType={equipmentType}
          unit={unit}
          weightStep={weightStep}
          plates={plates}
          barWeight={barWeight}
          onLog={(weight, reps) => onCompleteSet(currentSet, weight, reps)}
        />
      ) : (
        <View style={styles.allDoneBlock}>
          <Ionicons name="trophy" size={22} color="#2E90FA" />
          <Text style={styles.allDoneText}>All {totalSets} sets logged</Text>
        </View>
      )}

      {/* Session controls — deviations from the plan are one tap away */}
      {(onAddSet || (onEndExerciseEarly && !allDone)) && (
        <View style={styles.sessionControlsRow}>
          {onAddSet && (
            <TouchableOpacity
              onPress={onAddSet}
              style={styles.sessionControlBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Add a set to this exercise"
            >
              <Ionicons name="add" size={15} color="#1A6FE0" />
              <Text style={styles.sessionControlText}>Add set</Text>
            </TouchableOpacity>
          )}
          {onEndExerciseEarly && !allDone && (
            <TouchableOpacity
              onPress={onEndExerciseEarly}
              style={styles.sessionControlBtn}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Finish this exercise early"
            >
              <Ionicons name="flag-outline" size={14} color="#64748B" />
              <Text style={[styles.sessionControlText, styles.sessionControlTextMuted]}>
                Finish exercise early
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 4 },

  prevRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 12,
    gap: 8,
  },
  prevLabel: { fontSize: 11, fontWeight: '600', color: '#94A3B4' },
  prevValues: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'flex-end',
    gap: 4,
  },
  prevValueText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#334155',
    fontVariant: ['tabular-nums'],
  },
  prevMul: { fontSize: 11, color: '#94A3B4', fontWeight: '600' },
  repeatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#EAF3FF',
  },
  repeatBtnText: { fontSize: 12, fontWeight: '700', color: '#1A6FE0' },

  sessionControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 14,
  },
  sessionControlBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: '#F1F6FC',
    borderWidth: 1,
    borderColor: '#DBE7F5',
    justifyContent: 'center',
  },
  sessionControlText: { fontSize: 13, fontWeight: '700', color: '#1A6FE0' },
  sessionControlTextMuted: { color: '#64748B' },

  allDoneBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#EAF3FF',
    paddingVertical: 16,
    borderRadius: 16,
  },
  allDoneText: { fontSize: 14, fontWeight: '700', color: '#1A6FE0' },
});
