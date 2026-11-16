/**
 * LogWeightSheet — shared bottom sheet for logging a body-weight measurement.
 *
 * Used by both the Home tab (HomeMetricsRow) and the Progress tab. Writes a new
 * point to `body_weight_logs` (and syncs `user_profiles.weight_kg`) via
 * logBodyWeight().
 *
 * Goal-aware: when a goal weight + goal direction (lose / gain / maintain /
 * build_muscle) is provided, the sheet shows how the entered weight moves the
 * user relative to their target, and celebrates when the goal is reached.
 *
 * Weight is always stored in kg; the UI converts to the user's preferred unit.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { getThemeColors } from '../constants/theme';
import { logBodyWeight } from '../utils/userProfile';

const KG_TO_LBS = 2.20462;
const LBS_TO_KG = 0.453592;

// Goals that mean "weight should go down" vs "up". Maintain/build_muscle are
// treated as their own cases below.
type Goal = 'lose' | 'gain' | 'maintain' | 'build_muscle' | string;

export interface LogWeightSheetProps {
  visible: boolean;
  unit: 'kg' | 'lbs';
  /** Most recent logged weight in kg, used to pre-seed the input. */
  latestKg: number | null;
  /** Target weight in kg, if the user has set one. */
  goalWeightKg?: number | null;
  /** The user's goal direction, drives contextual copy. */
  goal?: Goal | null;
  userId: string;
  isDark: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

const LogWeightSheet: React.FC<LogWeightSheetProps> = ({
  visible,
  unit,
  latestKg,
  goalWeightKg,
  goal,
  userId,
  isDark,
  onClose,
  onSaved,
}) => {
  const colors = getThemeColors(isDark);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toDisplay = (kg: number) => (unit === 'lbs' ? kg * KG_TO_LBS : kg);

  useEffect(() => {
    if (visible) {
      const seed = latestKg != null ? toDisplay(latestKg) : null;
      setValue(seed != null ? seed.toFixed(1) : '');
      setError(null);
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, latestKg, unit]);

  // Live, goal-aware feedback as the user types. Returns null when there is no
  // goal context or the input isn't a usable number yet.
  const goalHint = useMemo(() => {
    if (goalWeightKg == null || goalWeightKg <= 0) return null;
    const num = parseFloat(value.replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) return null;
    const enteredKg = unit === 'lbs' ? num * LBS_TO_KG : num;
    const diffKg = enteredKg - goalWeightKg; // + = above goal, - = below goal
    const remainingDisplay = Math.abs(toDisplay(diffKg));

    // Within ~0.2kg counts as "reached".
    if (Math.abs(diffKg) <= 0.2) {
      return { tone: 'success' as const, icon: 'trophy' as const, text: 'Goal weight reached — nice work!' };
    }

    const isLoseLike = goal === 'lose';
    const isGainLike = goal === 'gain' || goal === 'build_muscle';

    if (isLoseLike) {
      return diffKg > 0
        ? { tone: 'neutral' as const, icon: 'flag-outline' as const, text: `${remainingDisplay.toFixed(1)} ${unit} to your goal` }
        : { tone: 'success' as const, icon: 'checkmark-circle' as const, text: `${remainingDisplay.toFixed(1)} ${unit} below your goal` };
    }
    if (isGainLike) {
      return diffKg < 0
        ? { tone: 'neutral' as const, icon: 'flag-outline' as const, text: `${remainingDisplay.toFixed(1)} ${unit} to your goal` }
        : { tone: 'success' as const, icon: 'checkmark-circle' as const, text: `${remainingDisplay.toFixed(1)} ${unit} above your goal` };
    }
    // Maintain (or unknown): show deviation either way.
    return {
      tone: 'neutral' as const,
      icon: 'swap-vertical-outline' as const,
      text: `${remainingDisplay.toFixed(1)} ${unit} ${diffKg > 0 ? 'above' : 'below'} target`,
    };
  }, [value, goalWeightKg, goal, unit]);

  const goalDirectionLabel = useMemo(() => {
    if (goal === 'lose') return 'losing';
    if (goal === 'gain' || goal === 'build_muscle') return 'gaining';
    if (goal === 'maintain') return 'maintaining';
    return null;
  }, [goal]);

  const handleSave = async () => {
    const num = parseFloat(value.replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) {
      setError('Enter a valid weight');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      return;
    }
    const kg = unit === 'lbs' ? num * LBS_TO_KG : num;
    if (kg < 20 || kg > 500) {
      setError('That weight looks off — double-check the number');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      return;
    }
    setSaving(true);
    setError(null);
    const { error: writeError } = await logBodyWeight(userId, kg);
    setSaving(false);
    if (writeError) {
      setError('Could not save — check your connection and try again');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    await onSaved();
  };

  const surface = isDark ? '#1A1A1A' : '#FFFFFF';
  const inputBg = isDark ? '#0F0F0F' : '#F5F5F5';
  const goalKgDisplay = goalWeightKg != null && goalWeightKg > 0 ? toDisplay(goalWeightKg) : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityLabel="Dismiss">
          <Pressable
            style={[styles.sheetCard, { backgroundColor: surface }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetGrabber} />
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Log weight</Text>
            <Text style={[styles.sheetSub, { color: colors.textMuted }]}>
              {goalKgDisplay != null && goalDirectionLabel
                ? `You're ${goalDirectionLabel} toward ${goalKgDisplay.toFixed(1)} ${unit}. Weigh in at the same time each day for the most consistent trend.`
                : 'Take a measurement when you wake up for the most consistent trend.'}
            </Text>

            <View style={[styles.sheetInputRow, { backgroundColor: inputBg }]}>
              <TextInput
                style={[styles.sheetInput, { color: colors.text }]}
                value={value}
                onChangeText={(v) => {
                  setValue(v);
                  setError(null);
                }}
                keyboardType="decimal-pad"
                placeholder="0.0"
                placeholderTextColor={colors.textMuted}
                autoFocus
                selectTextOnFocus
                accessibilityLabel="Body weight"
                returnKeyType="done"
                onSubmitEditing={handleSave}
              />
              <Text style={[styles.sheetInputUnit, { color: colors.textMuted }]}>{unit}</Text>
            </View>

            {/* Live goal-aware hint (suppressed while an error is showing). */}
            {!error && goalHint && (
              <View style={styles.hintRow}>
                <Ionicons
                  name={goalHint.icon}
                  size={15}
                  color={goalHint.tone === 'success' ? '#2E90FA' : colors.primary}
                />
                <Text
                  style={[
                    styles.hintText,
                    { color: goalHint.tone === 'success' ? '#2E90FA' : colors.textSecondary },
                  ]}
                >
                  {goalHint.text}
                </Text>
              </View>
            )}
            {error && (
              <Text style={styles.sheetError} accessibilityLiveRegion="assertive" accessibilityRole="alert">
                {error}
              </Text>
            )}

            <View style={styles.sheetActions}>
              <TouchableOpacity
                onPress={onClose}
                style={[styles.sheetBtn, styles.sheetBtnGhost, { borderColor: colors.border }]}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[styles.sheetBtnText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSave}
                style={[
                  styles.sheetBtn,
                  { backgroundColor: isDark ? '#FFFFFF' : '#000000', opacity: saving ? 0.7 : 1 },
                ]}
                disabled={saving}
                accessibilityRole="button"
                accessibilityLabel="Save weight entry"
                accessibilityState={{ disabled: saving, busy: saving }}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={isDark ? '#000' : '#FFF'} />
                ) : (
                  <Text style={[styles.sheetBtnText, { color: isDark ? '#000000' : '#FFFFFF' }]}>
                    Save
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 12,
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  sheetGrabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 4,
    backgroundColor: '#9CA3AF',
    opacity: 0.4,
    marginBottom: 16,
  },
  sheetTitle: { fontSize: 20, fontFamily: 'Montserrat_700Bold', marginBottom: 4 },
  sheetSub: { fontSize: 13, fontFamily: 'Montserrat_400Regular', lineHeight: 18, marginBottom: 20 },
  sheetInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 8,
  },
  sheetInput: {
    flex: 1,
    fontSize: 24,
    fontFamily: 'Montserrat_700Bold',
    fontVariant: ['tabular-nums'],
    padding: 0,
  },
  sheetInputUnit: { fontSize: 16, fontFamily: 'Montserrat_600SemiBold' },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  hintText: { fontSize: 13, fontFamily: 'Montserrat_600SemiBold' },
  sheetError: {
    fontSize: 13,
    fontFamily: 'Montserrat_600SemiBold',
    color: '#EF4444',
    marginTop: 12,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },
  sheetBtn: {
    flex: 1,
    height: 50,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBtnGhost: { backgroundColor: 'transparent', borderWidth: 1 },
  sheetBtnText: { fontSize: 15, fontFamily: 'Montserrat_700Bold' },
});

export default LogWeightSheet;