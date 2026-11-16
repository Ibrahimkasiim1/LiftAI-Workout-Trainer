/**
 * ActiveSetEditor — compact SetGraph-style set logger.
 *
 *   ┌─────────────────────────────────────────┐
 *   │  8 rep   [−] [+]   190 lb         []  │  ← compact top row
 *   ├─────────────────────────────────────────┤
 *   │  [plate builder / chips / keypad]       │
 *   ├─────────────────────────────────────────┤
 *   │  Set 3 / 4              [⌨ Keypad]     │
 *   └─────────────────────────────────────────┘
 *
 * Touchables are imported from `react-native-gesture-handler` because gorhom
 * BottomSheetScrollView (v5) does not reliably forward taps to the standard
 * react-native `Pressable`. This was the cause of dead taps.
 *
 * Prefill: weight + reps default to the user's most recent completed set
 * within this exercise's session (passed via `previousSet`). If there is no
 * previous set yet, falls back silently to the plan's recommended starting
 * weight. No AI reasoning text is shown.
 */

import { Ionicons } from '@expo/vector-icons';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import type { ExercisePerformanceLog } from '../../src/services/ProgressService';
import type { SetRecommendation } from '../../src/services/progressiveOverload';

export type EquipmentType = 'none' | 'barbell' | 'dumbbell' | 'machine';

interface Props {
  setNumber: number;
  totalSets: number;
  previousSet?: ExercisePerformanceLog;          // most recent in this session
  fallbackRecommendation?: SetRecommendation;    // used only when no previousSet
  equipmentType: EquipmentType;
  unit: 'kg' | 'lbs';
  weightStep: number;
  plates: readonly number[];
  barWeight: number;
  onLog: (weight: number, reps: number) => void;
}

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(n.toString().split('.')[1]?.length === 1 ? 1 : 2);
};

const decomposePlates = (
  target: number,
  barWeight: number,
  plates: readonly number[],
  balanced: boolean = true,
): Record<number, number> => {
  const counts: Record<number, number> = {};
  // balanced → counts are per-side (each adds a pair); otherwise total plates.
  const load = balanced ? (target - barWeight) / 2 : target - barWeight;
  if (load <= 0) return counts;
  let remaining = load;
  for (const p of [...plates].sort((a, b) => b - a)) {
    let n = 0;
    while (remaining >= p - 0.001) {
      n += 1;
      remaining -= p;
    }
    if (n > 0) counts[p] = n;
  }
  return counts;
};

const DUMBBELL_LBS: number[] = (() => {
  const out: number[] = [];
  for (let w = 5; w <= 50; w += 2.5) out.push(w);
  for (let w = 55; w <= 120; w += 5) out.push(w);
  return out;
})();
const DUMBBELL_KG: number[] = (() => {
  const out: number[] = [];
  for (let w = 2.5; w <= 50; w += 2.5) out.push(w);
  for (let w = 55; w <= 60; w += 5) out.push(w);
  return out;
})();

export default function ActiveSetEditor({
  setNumber,
  totalSets,
  previousSet,
  fallbackRecommendation,
  equipmentType,
  unit,
  weightStep,
  plates,
  barWeight,
  onLog,
}: Props) {
  const isBodyweight = equipmentType === 'none';

  const [weight, setWeight] = useState<number>(0);
  const [reps, setReps] = useState<number>(0);
  const [focusedField, setFocusedField] = useState<'reps' | 'weight'>('reps');
  const [inputMode, setInputMode] = useState<'smart' | 'keypad'>('smart');
  const [plateCounts, setPlateCounts] = useState<Record<number, number>>({});
  const [bwLoadEnabled, setBwLoadEnabled] = useState<boolean>(false);
  // Barbell only: when on, each plate is mirrored on both sides (a pair).
  const [balanced, setBalanced] = useState<boolean>(true);
  // Inline caption shown when Log is tapped with missing weight/reps.
  const [validationError, setValidationError] = useState<string | null>(null);

  // The error names a missing value — any edit to either value clears it.
  useEffect(() => {
    setValidationError(null);
  }, [weight, reps]);

  // Native keyboard handling — tapping a value slot that is ALREADY focused
  // swaps it to an inline TextInput with autoFocus (system numeric keypad).
  // First tap focuses, second tap types: no hidden double-tap timing window.
  const [nativeField, setNativeField] = useState<'weight' | 'reps' | null>(null);
  const weightNativeRef = useRef<TextInput>(null);
  const repsNativeRef = useRef<TextInput>(null);

  const handleValueTap = (field: 'weight' | 'reps') => {
    if (inputMode === 'smart' && focusedField === field) {
      setNativeField(field);
      return;
    }
    setFocusedField(field);
  };

  // Prefill from previous set (preferred), else fallback recommendation.
  //
  // We depend on PRIMITIVE values (weight/reps/set_number) — not on the
  // previousSet object itself — because parent re-renders create a new
  // object reference each time. Depending on the object would re-fire this
  // effect on every parent render and wipe the user's in-progress edits
  // (e.g. tapping a plate +/- would reset back to the prefilled weight).
  const prevSetNum = previousSet?.set_number ?? -1;
  const prevWeight = previousSet?.weight_used ?? -1;
  const prevReps = previousSet?.reps_completed ?? -1;
  const fbWeight = fallbackRecommendation?.weight ?? 0;
  const fbReps = fallbackRecommendation?.reps ?? 0;

  useEffect(() => {
    const hasPrev = prevSetNum >= 0;
    const w = hasPrev ? prevWeight : fbWeight;
    const r = hasPrev ? prevReps : fbReps;
    setWeight(w);
    setReps(r);
    setFocusedField('reps');
    setInputMode('smart');
    setBwLoadEnabled(false);
    setNativeField(null);
    setBalanced(true);
    if (equipmentType === 'barbell') {
      setPlateCounts(decomposePlates(w, barWeight, plates, true));
    } else {
      setPlateCounts({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNumber, prevSetNum, prevWeight, prevReps, fbWeight, fbReps, equipmentType, barWeight]);

  const clampWeight = (w: number) => Math.max(0, Math.min(2000, w));
  const clampReps = (r: number) => Math.max(0, Math.min(999, Math.round(r)));

  const setWeightAndPlates = (w: number) => {
    const clamped = clampWeight(w);
    setWeight(clamped);
    if (equipmentType === 'barbell') {
      setPlateCounts(decomposePlates(clamped, barWeight, plates, balanced));
    }
  };

  // Toggle balanced loading while preserving the current total weight.
  const toggleBalanced = () => {
    Haptics.selectionAsync();
    setBalanced((prev) => {
      const next = !prev;
      setPlateCounts(decomposePlates(weight, barWeight, plates, next));
      return next;
    });
  };

  const nudgeFocused = (dir: 1 | -1) => {
    Haptics.selectionAsync();
    if (focusedField === 'weight') {
      let next = weight + dir * weightStep;
      next = Math.round(next / weightStep) * weightStep;
      setWeightAndPlates(next);
    } else {
      setReps((r) => clampReps(r + dir));
    }
  };

  const typeDigit = (d: string) => {
    Haptics.selectionAsync();
    if (focusedField === 'weight') {
      const s = fmt(weight);
      let next = s;
      if (d === '⌫') next = s.length > 1 ? s.slice(0, -1) : '0';
      else if (d === '.') next = s.includes('.') ? s : s + '.';
      else next = s === '0' ? d : s + d;
      const parsed = parseFloat(next.replace(/[^0-9.]/g, ''));
      setWeightAndPlates(Number.isFinite(parsed) ? parsed : 0);
    } else {
      const s = reps.toString();
      let next = s;
      if (d === '⌫') next = s.length > 1 ? s.slice(0, -1) : '0';
      else if (d === '.') return;
      else next = s === '0' ? d : s + d;
      const parsed = parseInt(next.replace(/[^0-9]/g, ''), 10);
      setReps(clampReps(Number.isFinite(parsed) ? parsed : 0));
    }
  };

  const adjustPlate = (size: number, delta: number) => {
    Haptics.selectionAsync();
    setPlateCounts((prev) => {
      const next = { ...prev, [size]: Math.max(0, (prev[size] || 0) + delta) };
      if (next[size] === 0) delete next[size];
      const mult = balanced ? 2 : 1;
      const w = barWeight + mult * Object.entries(next).reduce(
        (acc, [s, n]) => acc + parseFloat(s) * n,
        0,
      );
      setWeight(clampWeight(w));
      return next;
    });
  };

  const handleLog = () => {
    const showWeight = !isBodyweight || bwLoadEnabled;
    const w = showWeight ? weight : 0;
    const r = clampReps(reps);
    // Validation failures must be VISIBLE, not haptic-only — with the phone
    // at arm's length on a bench, a silent early-return reads as a dead tap.
    if (showWeight && !isBodyweight && w <= 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setValidationError('Enter the weight you lifted');
      setFocusedField('weight');
      return;
    }
    if (r <= 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setValidationError('Enter your reps');
      setFocusedField('reps');
      return;
    }
    setValidationError(null);
    // No success haptic here — the parent fires it after the save is
    // confirmed, so feedback can't outrun the database.
    onLog(w, r);
  };

  const showWeight = !isBodyweight || bwLoadEnabled;

  return (
    <View style={styles.wrap}>
      {/* Top compact row */}
      <View style={styles.topRow}>
        {nativeField === 'reps' ? (
          <View style={[styles.valueSlot, styles.valueSlotFocused]}>
            <Text style={[styles.slotCaption, styles.slotCaptionFocused]}>REPS</Text>
            <BottomSheetTextInput
              ref={repsNativeRef as any}
              style={styles.valueInput}
              value={reps === 0 ? '' : reps.toString()}
              onChangeText={(t) => {
                const cleaned = t.replace(/[^0-9]/g, '');
                const n = cleaned === '' ? 0 : parseInt(cleaned, 10);
                setReps(clampReps(Number.isFinite(n) ? n : 0));
              }}
              keyboardType="number-pad"
              returnKeyType="done"
              autoFocus
              selectTextOnFocus
              onBlur={() => setNativeField(null)}
              onSubmitEditing={() => setNativeField(null)}
              placeholder="0"
            />
          </View>
        ) : (
          <TouchableOpacity
            onPress={() => handleValueTap('reps')}
            style={[styles.valueSlot, focusedField === 'reps' && styles.valueSlotFocused]}
            activeOpacity={0.7}
          >
            <Text style={[styles.slotCaption, focusedField === 'reps' && styles.slotCaptionFocused]}>
              REPS
            </Text>
            <Text style={styles.valueText}>{reps}</Text>
          </TouchableOpacity>
        )}

        <View style={styles.stepper}>
          <TouchableOpacity
            onPress={() => nudgeFocused(1)}
            style={styles.stepperBtn}
            hitSlop={{ top: 8, bottom: 4, left: 8, right: 8 }}
            activeOpacity={0.5}
          >
            <Ionicons name="add" size={20} color="#2E90FA" />
          </TouchableOpacity>
          <View style={styles.stepperDivider} />
          <TouchableOpacity
            onPress={() => nudgeFocused(-1)}
            style={styles.stepperBtn}
            hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
            activeOpacity={0.5}
          >
            <Ionicons name="remove" size={20} color="#2E90FA" />
          </TouchableOpacity>
        </View>

        {showWeight ? (
          nativeField === 'weight' ? (
            <View style={[styles.valueSlot, styles.valueSlotFocused]}>
              <Text style={[styles.slotCaption, styles.slotCaptionFocused]}>
                WEIGHT · {unit.toUpperCase()}
              </Text>
              <BottomSheetTextInput
                ref={weightNativeRef as any}
                style={styles.valueInput}
                value={weight === 0 ? '' : fmt(weight)}
                onChangeText={(t) => {
                  const cleaned = t.replace(/[^0-9.]/g, '');
                  const n = cleaned === '' || cleaned === '.' ? 0 : parseFloat(cleaned);
                  setWeightAndPlates(Number.isFinite(n) ? n : 0);
                }}
                keyboardType="decimal-pad"
                returnKeyType="done"
                autoFocus
                selectTextOnFocus
                onBlur={() => setNativeField(null)}
                onSubmitEditing={() => setNativeField(null)}
                placeholder="0"
              />
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => handleValueTap('weight')}
              style={[styles.valueSlot, focusedField === 'weight' && styles.valueSlotFocused]}
              activeOpacity={0.7}
            >
              <Text
                style={[styles.slotCaption, focusedField === 'weight' && styles.slotCaptionFocused]}
              >
                WEIGHT · {unit.toUpperCase()}
              </Text>
              <Text style={styles.valueText}>{fmt(weight)}</Text>
            </TouchableOpacity>
          )
        ) : isBodyweight ? (
          <TouchableOpacity
            onPress={() => {
              setBwLoadEnabled(true);
              setFocusedField('weight');
            }}
            style={styles.addLoadBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="add-circle-outline" size={15} color="#94A3B4" />
            <Text style={styles.addLoadText}>Add load</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Smart panel */}
      <View style={styles.panel}>
        {inputMode === 'keypad' ? (
          <NumericKeypad onPress={typeDigit} allowDecimal={focusedField === 'weight'} />
        ) : isBodyweight && !bwLoadEnabled ? (
          <BodyweightRepChips
            onAddReps={(d) => {
              Haptics.selectionAsync();
              setReps((r) => clampReps(r + d));
            }}
          />
        ) : equipmentType === 'barbell' ? (
          <View style={styles.barbellPanel}>
            <TouchableOpacity
              onPress={toggleBalanced}
              style={styles.balanceRow}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityState={{ checked: balanced }}
              accessibilityLabel="Balance bar — load each plate on both sides"
            >
              <Text style={styles.balanceLabel}>Balance both sides</Text>
              <View style={[styles.toggleTrack, balanced && styles.toggleTrackOn]}>
                <View style={[styles.toggleKnob, balanced && styles.toggleKnobOn]} />
              </View>
            </TouchableOpacity>
            <PlateBuilder
              plates={plates}
              counts={plateCounts}
              onAdjust={adjustPlate}
            />
          </View>
        ) : equipmentType === 'dumbbell' ? (
          <WeightChipScroll
            values={unit === 'lbs' ? DUMBBELL_LBS : DUMBBELL_KG}
            selected={weight}
            unit={unit}
            onSelect={(v) => {
              Haptics.selectionAsync();
              setWeightAndPlates(v);
              setFocusedField('weight');
            }}
          />
        ) : (
          <MachineChips
            unit={unit}
            onAdjust={(d) => {
              Haptics.selectionAsync();
              setWeightAndPlates(weight + d);
              setFocusedField('weight');
            }}
          />
        )}
      </View>

      {/* Footer: set progress + mode toggle */}
      <View style={styles.footer}>
        <View style={styles.setProgress}>
          <View style={styles.dotsRow}>
            {Array.from({ length: totalSets }).map((_, i) => {
              const n = i + 1;
              const done = n < setNumber;
              const current = n === setNumber;
              return (
                <View
                  key={n}
                  style={[
                    styles.dot,
                    done && styles.dotDone,
                    current && styles.dotCurrent,
                  ]}
                />
              );
            })}
          </View>
          <Text style={styles.setCounter}>
            Set {setNumber} of {totalSets}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setInputMode((m) => (m === 'smart' ? 'keypad' : 'smart'))}
          style={styles.modeToggle}
          activeOpacity={0.6}
        >
          <Ionicons
            name={inputMode === 'keypad' ? 'apps' : 'keypad'}
            size={14}
            color="#64748B"
          />
          <Text style={styles.modeText}>
            {inputMode === 'keypad' ? 'Smart' : 'Keypad'}
          </Text>
        </TouchableOpacity>
      </View>

      {validationError && (
        <Text style={styles.validationText} accessibilityLiveRegion="polite">
          {validationError}
        </Text>
      )}

      {/* Primary CTA — full-width, states exactly what one tap commits so the
          prefilled happy path is a single glance + single tap. */}
      <TouchableOpacity style={styles.confirmBtn} onPress={handleLog} activeOpacity={0.85}>
        <Ionicons name="checkmark" size={18} color="#FFF" />
        <Text style={styles.confirmText}>
          {showWeight && weight > 0
            ? `Log ${fmt(weight)} ${unit} × ${reps}`
            : `Log ${reps} reps`}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ── PlateBuilder ──────────────────────────────────────────────────────────

function PlateBuilder({
  plates,
  counts,
  onAdjust,
}: {
  plates: readonly number[];
  counts: Record<number, number>;
  onAdjust: (size: number, delta: number) => void;
}) {
  const sorted = useMemo(() => [...plates].sort((a, b) => a - b), [plates]);
  return (
    <View style={styles.plateRow}>
      {sorted.map((size) => {
        const n = counts[size] || 0;
        return (
          <View key={size} style={styles.plateTile}>
            <TouchableOpacity
              onPress={() => onAdjust(size, 1)}
              style={styles.plateBtn}
              activeOpacity={0.5}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            >
              {n > 0 ? (
                <View style={styles.plateBadge}>
                  <Text style={styles.plateBadgeText}>{n}</Text>
                </View>
              ) : (
                <Ionicons name="add" size={16} color="#888" />
              )}
            </TouchableOpacity>
            <Text style={[styles.plateLabel, n > 0 && styles.plateLabelActive]}>
              {fmt(size)}
            </Text>
            <TouchableOpacity
              onPress={() => onAdjust(size, -1)}
              disabled={n === 0}
              style={[styles.plateBtn, n === 0 && styles.plateBtnDisabled]}
              activeOpacity={0.5}
              hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            >
              <Ionicons name="remove" size={16} color={n === 0 ? '#CCC' : '#888'} />
            </TouchableOpacity>
          </View>
        );
      })}
    </View>
  );
}

// ── WeightChipScroll (dumbbell) ───────────────────────────────────────────

function WeightChipScroll({
  values,
  selected,
  unit,
  onSelect,
}: {
  values: number[];
  selected: number;
  unit: 'kg' | 'lbs';
  onSelect: (v: number) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipScrollContent}
    >
      {values.map((v) => {
        const isSel = Math.abs(v - selected) < 0.01;
        return (
          <TouchableOpacity
            key={v}
            onPress={() => onSelect(v)}
            style={[styles.dbChip, isSel && styles.dbChipSelected]}
            activeOpacity={0.6}
          >
            <Text style={[styles.dbChipText, isSel && styles.dbChipTextSelected]}>
              {fmt(v)}
            </Text>
            <Text style={[styles.dbChipUnit, isSel && styles.dbChipUnitSelected]}>
              {unit}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ── MachineChips ──────────────────────────────────────────────────────────

function MachineChips({
  unit,
  onAdjust,
}: {
  unit: 'kg' | 'lbs';
  onAdjust: (delta: number) => void;
}) {
  const deltas = unit === 'lbs' ? [-25, -10, -5, 5, 10, 25] : [-10, -5, -2.5, 2.5, 5, 10];
  return (
    <View style={styles.chipsGrid}>
      {deltas.map((d) => (
        <TouchableOpacity
          key={d}
          onPress={() => onAdjust(d)}
          style={[
            styles.smallChip,
            d > 0 && styles.smallChipPos,
            d < 0 && styles.smallChipNeg,
          ]}
          activeOpacity={0.6}
        >
          <Text
            style={[
              styles.smallChipText,
              d > 0 && styles.smallChipTextPos,
              d < 0 && styles.smallChipTextNeg,
            ]}
          >
            {d > 0 ? `+${d}` : d}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ── BodyweightRepChips ────────────────────────────────────────────────────

function BodyweightRepChips({ onAddReps }: { onAddReps: (d: number) => void }) {
  const deltas = [-5, -1, 1, 5, 10];
  return (
    <View style={styles.chipsGrid}>
      {deltas.map((d) => (
        <TouchableOpacity
          key={d}
          onPress={() => onAddReps(d)}
          style={[
            styles.smallChip,
            d > 0 && styles.smallChipPos,
            d < 0 && styles.smallChipNeg,
          ]}
          activeOpacity={0.6}
        >
          <Text
            style={[
              styles.smallChipText,
              d > 0 && styles.smallChipTextPos,
              d < 0 && styles.smallChipTextNeg,
            ]}
          >
            {d > 0 ? `+${d}` : d}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ── NumericKeypad ─────────────────────────────────────────────────────────

function NumericKeypad({
  onPress,
  allowDecimal,
}: {
  onPress: (digit: string) => void;
  allowDecimal: boolean;
}) {
  const rows: (string | null)[][] = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    [allowDecimal ? '.' : null, '0', '⌫'],
  ];
  return (
    <View>
      {rows.map((row, ri) => (
        <View key={ri} style={styles.keypadRow}>
          {row.map((k, i) => (
            // Sizing wrapper — gesture-handler's TouchableOpacity does not
            // always honor flex:1 directly, so the parent View claims the
            // width and the touchable fills it.
            <View key={`${ri}-${i}`} style={styles.keypadCell}>
              <TouchableOpacity
                onPress={() => k && onPress(k)}
                disabled={!k}
                style={[styles.keypadKey, !k && styles.keypadKeyHidden]}
                activeOpacity={0.5}
              >
                {k === '⌫' ? (
                  <Ionicons name="backspace-outline" size={22} color="#222" />
                ) : k ? (
                  <Text style={styles.keypadText}>{k}</Text>
                ) : null}
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// ── Styles (compact) ──────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Flat wrapper — no card/border so it doesn't nest a box inside the sheet.
  wrap: {
    paddingTop: 2,
  },

  topRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 8,
  },
  // Value slots use a soft fill instead of a border (less visual noise).
  // A transparent 1.5px border is reserved on the base so the focused state
  // can swap in a colored border without shifting layout.
  valueSlot: {
    width: 108,
    minHeight: 56,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 16,
    backgroundColor: '#F3F5F9',
    borderWidth: 1.5,
    borderColor: 'transparent',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  valueSlotFocused: {
    backgroundColor: '#EAF3FF',
    borderColor: '#2E90FA',
  },
  slotCaption: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: '#9AA5B4',
    textAlign: 'center',
  },
  slotCaptionFocused: { color: '#2E90FA' },
  valueText: {
    fontSize: 23,
    fontWeight: '800',
    color: '#0F172A',
    fontVariant: ['tabular-nums'],
    lineHeight: 27,
    textAlign: 'center',
  },
  // Inline TextInput swapped in when user double-taps a value slot.
  valueInput: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    fontSize: 23,
    fontWeight: '800',
    color: '#0F172A',
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
    minWidth: 48,
    lineHeight: 27,
  },

  // Compact vertical +/- stepper (acts on the focused field).
  stepper: {
    width: 46,
    minHeight: 56,
    borderRadius: 16,
    backgroundColor: '#EAF3FF',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  stepperBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#CFE3FB' },

  addLoadBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: 16,
    backgroundColor: '#F3F5F9',
  },
  addLoadText: { fontSize: 12, color: '#94A3B4', fontWeight: '600' },

  validationText: {
    color: '#EF4444',
    fontSize: 12.5,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 12,
    marginBottom: -6,
  },

  // Full-width primary CTA — big target for gym conditions (sweaty thumbs,
  // phone on a bench), and the label carries the values being committed.
  confirmBtn: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#2E90FA',
    marginTop: 16,
  },
  confirmText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFF',
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },

  panel: {
    marginTop: 12,
    minHeight: 84,
    justifyContent: 'center',
  },

  // Plate builder
  barbellPanel: { gap: 8 },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 12,
    paddingVertical: 1,
  },
  balanceLabel: { fontSize: 12, fontWeight: '600', color: '#475569' },
  // Minimal pill toggle.
  toggleTrack: {
    width: 40,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#E2E8F0',
    padding: 2,
    flexDirection: 'row',
  },
  toggleTrackOn: { backgroundColor: '#2E90FA' },
  toggleKnob: {
    width: 20,
    height: 20,
    borderRadius: 12,
    backgroundColor: '#FFF',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  toggleKnobOn: { marginLeft: 'auto' },
  plateRow: {
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'space-between',
  },
  plateTile: {
    flex: 1,
    backgroundColor: '#F3F5F9',
    borderRadius: 12,
    alignItems: 'center',
    paddingVertical: 4,
    gap: 1,
  },
  // 42×32 visual + vertical hitSlop at the call sites ⇒ ≥44pt effective
  // target — these get hammered with chalky/sweaty thumbs mid-set.
  plateBtn: {
    width: 42,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plateBtnDisabled: { opacity: 0.4 },
  plateBadge: {
    width: 22,
    height: 22,
    borderRadius: 12,
    backgroundColor: '#2E90FA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  plateBadgeText: { color: '#FFF', fontWeight: '700', fontSize: 12 },
  plateLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#9AA5B4',
    fontVariant: ['tabular-nums'],
  },
  plateLabelActive: { color: '#0F172A' },

  // Dumbbell chip scroll
  chipScrollContent: { gap: 8, paddingHorizontal: 2 },
  dbChip: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#F3F5F9',
    alignItems: 'center',
    minWidth: 50,
  },
  dbChipSelected: {
    backgroundColor: '#2E90FA',
  },
  dbChipText: { fontSize: 15, fontWeight: '700', color: '#0F172A', fontVariant: ['tabular-nums'] },
  dbChipTextSelected: { color: '#FFF' },
  dbChipUnit: { fontSize: 9, fontWeight: '600', color: '#9AA5B4', marginTop: 1 },
  dbChipUnitSelected: { color: '#DCE9FF' },

  // Generic small chip grid (machine + rep chips)
  chipsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  smallChip: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#F3F5F9',
    minWidth: 54,
    alignItems: 'center',
  },
  smallChipPos: { backgroundColor: '#EAF3FF' },
  smallChipNeg: { backgroundColor: '#FEF3F2' },
  smallChipText: { fontSize: 14, fontWeight: '700', color: '#475569', fontVariant: ['tabular-nums'] },
  smallChipTextPos: { color: '#1A6FE0' },
  smallChipTextNeg: { color: '#B91C1C' },

  // Keypad — explicit rows; each cell (View) claims flex width, the
  // touchable inside fills it. Keys are ≥44pt to meet touch-target guidance.
  keypadRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  keypadCell: { flex: 1 },
  keypadKey: {
    width: '100%',
    height: 46,
    borderRadius: 12,
    backgroundColor: '#F3F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keypadKeyHidden: { opacity: 0, backgroundColor: 'transparent' },
  keypadText: { fontSize: 20, fontWeight: '600', color: '#0F172A', fontVariant: ['tabular-nums'] },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingHorizontal: 2,
  },
  setProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 4,
    backgroundColor: '#E2E8F0',
  },
  dotDone: { backgroundColor: '#2E90FA' },
  dotCurrent: { width: 16, backgroundColor: '#2E90FA' },
  setCounter: { fontSize: 12, fontWeight: '600', color: '#94A3B4' },
  modeToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#F3F5F9',
  },
  modeText: { fontSize: 11, color: '#64748B', fontWeight: '600' },
});
