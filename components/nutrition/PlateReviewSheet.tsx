import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import type { MealPhotoItem, NutritionClarification } from '../../src/api/backendClient';

// ── Types ──────────────────────────────────────────────────────────────────

/** One editable Plate-card row: the AI's base estimate × a user quantity. */
type PlateItemDraft = {
  key: string;
  base: MealPhotoItem;
  qty: number;
};

export type PlateEditType =
  | 'multiplier'
  | 'item_removed'
  | 'item_added'
  | 'stepper'
  | 'fix_note';

export type PlateReviewSheetProps = {
  /** 'new' = fresh analysis (fix + retake available); 'edit' = saved log reopened. */
  mode: 'new' | 'edit';
  photoUri: string | null;
  mealName: string;
  items: MealPhotoItem[];
  confidence: 'high' | 'medium' | 'low';
  clarification: NutritionClarification | null;
  flags: { packaged: boolean; blended: boolean; multi_plate: boolean };
  fixesRemaining: number;
  onLog: (payload: { mealName: string; items: Omit<MealPhotoItem, 'confidence'>[] }) => Promise<void>;
  onRetake: () => void;
  /** "Fix with a note" — free re-analysis. Absent in edit mode. */
  onFix?: (note: string) => Promise<void>;
  /** Packaged-food handoff into the barcode scanner (free, exact numbers). */
  onScanBarcode?: () => void;
  /** "+ Add item" text → parsed item (null on failure). */
  onParseItem: (text: string) => Promise<MealPhotoItem | null>;
  onEdited?: (type: PlateEditType) => void;
};

const PLATE_MULTIPLIERS = [0.5, 0.75, 1, 1.5, 2] as const;

function scaleRound(value: number, scale: number): number {
  return Math.max(0, Math.round(value * scale));
}

/**
 * The Plate card: itemized, editable review of a photo analysis, shown as a
 * bottom sheet over the frozen capture. Nothing persists until "Log meal" —
 * all quantity/multiplier math is client-side; the server recomputes totals
 * from the submitted items on confirm.
 */
export default function PlateReviewSheet({
  mode,
  photoUri,
  mealName: initialMealName,
  items: initialItems,
  confidence,
  clarification,
  flags,
  fixesRemaining,
  onLog,
  onRetake,
  onFix,
  onScanBarcode,
  onParseItem,
  onEdited,
}: PlateReviewSheetProps) {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const sheetRef = useRef<BottomSheet>(null);

  const [mealName, setMealName] = useState(initialMealName);
  const [drafts, setDrafts] = useState<PlateItemDraft[]>([]);
  const [plateMult, setPlateMult] = useState(1);
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);
  const [fixNote, setFixNote] = useState('');
  const [fixing, setFixing] = useState(false);
  const [logging, setLogging] = useState(false);

  // Re-seed when a fix pass replaces the analysis (items identity changes).
  useEffect(() => {
    setDrafts(
      initialItems.map((base, i) => ({ key: `${i}-${base.name}`, base, qty: 1 }))
    );
    setPlateMult(1);
    setFixNote('');
  }, [initialItems]);

  useEffect(() => {
    setMealName(initialMealName);
  }, [initialMealName]);

  const totals = useMemo(() => {
    const sum = drafts.reduce(
      (acc, d) => {
        acc.calories += d.base.calories * d.qty;
        acc.protein += d.base.protein * d.qty;
        acc.carbs += d.base.carbs * d.qty;
        acc.fats += d.base.fats * d.qty;
        return acc;
      },
      { calories: 0, protein: 0, carbs: 0, fats: 0 }
    );
    return {
      calories: scaleRound(sum.calories, plateMult),
      protein: scaleRound(sum.protein, plateMult),
      carbs: scaleRound(sum.carbs, plateMult),
      fats: scaleRound(sum.fats, plateMult),
    };
  }, [drafts, plateMult]);

  const setQty = useCallback(
    (key: string, delta: number) => {
      setDrafts((prev) =>
        prev.map((d) =>
          d.key === key ? { ...d, qty: Math.min(20, Math.max(0.5, +(d.qty + delta).toFixed(2))) } : d
        )
      );
      onEdited?.('stepper');
    },
    [onEdited]
  );

  const removeItem = useCallback(
    (key: string) => {
      setDrafts((prev) => prev.filter((d) => d.key !== key));
      onEdited?.('item_removed');
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [onEdited]
  );

  const handleAddItem = async () => {
    const text = addText.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const item = await onParseItem(text);
      if (item) {
        setDrafts((prev) => [
          ...prev,
          { key: `added-${Date.now()}-${item.name}`, base: item, qty: 1 },
        ]);
        setAddText('');
        onEdited?.('item_added');
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } finally {
      setAdding(false);
    }
  };

  const handleFix = async () => {
    const note = fixNote.trim();
    if (!note || fixing || !onFix) return;
    setFixing(true);
    try {
      onEdited?.('fix_note');
      await onFix(note);
    } finally {
      setFixing(false);
    }
  };

  const handleLog = async () => {
    if (logging || drafts.length === 0) return;
    setLogging(true);
    try {
      await onLog({
        mealName: mealName.trim() || 'Meal',
        items: drafts.map((d) => {
          const scale = d.qty * plateMult;
          return {
            name: d.base.name,
            portion: d.qty !== 1 ? `${d.qty}× ${d.base.portion}` : d.base.portion,
            grams: d.base.grams != null ? scaleRound(d.base.grams, scale) : null,
            calories: scaleRound(d.base.calories, scale),
            protein: scaleRound(d.base.protein, scale),
            carbs: scaleRound(d.base.carbs, scale),
            fats: scaleRound(d.base.fats, scale),
          };
        }),
      });
    } finally {
      setLogging(false);
    }
  };

  const hairline = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(11,18,32,0.10)';
  // OPAQUE surfaces only: this sheet floats over the captured meal photo, so
  // the theme's alpha card tokens (5% white) render as see-through here.
  const sheetBg = isDark ? '#12161D' : '#FFFFFF';
  const cardBg = isDark ? '#1C222B' : '#F4F6F8';
  const stepBg = isDark ? '#262D37' : '#EBEEF2';
  const canFix = mode === 'new' && !!onFix && fixesRemaining > 0;
  const fixPlaceholder =
    clarification?.question ?? "Tell the AI what's off — “that's ranch, not yogurt”";

  return (
    <BottomSheet
      ref={sheetRef}
      snapPoints={['64%', '92%']}
      index={0}
      enablePanDownToClose={false}
      backgroundStyle={{ backgroundColor: sheetBg }}
      handleIndicatorStyle={{ backgroundColor: colors.textMuted }}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header: thumbnail + editable meal name */}
        <View style={styles.headerRow}>
          {photoUri ? (
            <Image source={{ uri: photoUri }} style={styles.thumb} contentFit="cover" />
          ) : (
            <View style={[styles.thumb, styles.thumbFallback, { backgroundColor: cardBg }]}>
              <Ionicons name="restaurant-outline" size={20} color={colors.textTertiary} />
            </View>
          )}
          <View style={styles.headerText}>
            <BottomSheetTextInput
              style={[styles.mealNameInput, { color: colors.text }]}
              value={mealName}
              onChangeText={setMealName}
              placeholder="Meal name"
              placeholderTextColor={colors.textMuted}
              maxLength={140}
              returnKeyType="done"
            />
            <Text style={[styles.estimateNote, { color: colors.textTertiary }]}>
              {mode === 'edit'
                ? 'Adjust items, then save'
                : 'AI estimate — like a nutrition label, not a lab'}
            </Text>
          </View>
        </View>

        {/* Totals */}
        <View style={[styles.totalsCard, { borderColor: hairline, backgroundColor: cardBg }]}>
          <Text style={[styles.totalKcal, { color: colors.text }]}>
            {totals.calories}
            <Text style={[styles.totalKcalUnit, { color: colors.textTertiary }]}> kcal</Text>
          </Text>
          <View style={styles.macroChipRow}>
            {([
              [totals.protein, 'protein'],
              [totals.carbs, 'carbs'],
              [totals.fats, 'fat'],
            ] as const).map(([value, label]) => (
              <View key={label} style={[styles.macroChip, { borderColor: hairline }]}>
                <Text style={[styles.macroChipValue, { color: colors.text }]}>{value}g</Text>
                <Text style={[styles.macroChipLabel, { color: colors.textMuted }]}>{label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Contextual banners */}
        {flags.packaged && onScanBarcode ? (
          <Pressable
            onPress={onScanBarcode}
            style={[styles.banner, { borderColor: colors.primary + '55', backgroundColor: colors.primary + '14' }]}
            accessibilityRole="button"
          >
            <Ionicons name="barcode-outline" size={16} color={colors.primary} />
            <Text style={[styles.bannerText, { color: colors.text }]}>
              Packaged food? Scan the barcode for exact numbers
            </Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textTertiary} />
          </Pressable>
        ) : null}
        {flags.multi_plate ? (
          <View style={[styles.banner, { borderColor: hairline, backgroundColor: cardBg }]}>
            <Ionicons name="people-outline" size={16} color={colors.textMuted} />
            <Text style={[styles.bannerText, { color: colors.textMuted }]}>
              Logging just your plate? Remove items that aren’t yours.
            </Text>
          </View>
        ) : null}
        {confidence !== 'high' && canFix ? (
          <View style={[styles.banner, { borderColor: hairline, backgroundColor: cardBg }]}>
            <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
            <Text style={[styles.bannerText, { color: colors.textMuted }]}>
              Rough estimate — add a detail below to tighten it up.
            </Text>
          </View>
        ) : null}

        {/* Items */}
        <View style={styles.itemsBlock}>
          {drafts.map((d) => {
            const scale = d.qty * plateMult;
            return (
              <View key={d.key} style={[styles.itemRow, { borderColor: hairline }]}>
                <View style={styles.itemInfo}>
                  <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={1}>
                    {d.base.name}
                  </Text>
                  <Text style={[styles.itemSub, { color: colors.textTertiary }]} numberOfLines={1}>
                    {d.qty !== 1 ? `${d.qty}× ` : ''}
                    {d.base.portion || '—'} · {scaleRound(d.base.calories, scale)} kcal
                    {d.base.confidence === 'low' ? ' · unsure' : ''}
                  </Text>
                </View>
                <View style={styles.itemControls}>
                  <Pressable
                    onPress={() => setQty(d.key, -0.5)}
                    hitSlop={8}
                    style={[styles.stepBtn, { backgroundColor: stepBg }]}
                    accessibilityLabel={`Decrease ${d.base.name}`}
                  >
                    <Ionicons name="remove" size={15} color={colors.text} />
                  </Pressable>
                  <Text style={[styles.stepValue, { color: colors.text }]}>{d.qty}</Text>
                  <Pressable
                    onPress={() => setQty(d.key, 0.5)}
                    hitSlop={8}
                    style={[styles.stepBtn, { backgroundColor: stepBg }]}
                    accessibilityLabel={`Increase ${d.base.name}`}
                  >
                    <Ionicons name="add" size={15} color={colors.text} />
                  </Pressable>
                  <Pressable
                    onPress={() => removeItem(d.key)}
                    hitSlop={8}
                    style={styles.removeBtn}
                    accessibilityLabel={`Remove ${d.base.name}`}
                  >
                    <Ionicons name="close" size={16} color={colors.textTertiary} />
                  </Pressable>
                </View>
              </View>
            );
          })}

          {/* + Add item */}
          <View style={[styles.addRow, { borderColor: hairline }]}>
            <Ionicons name="add-circle-outline" size={18} color={colors.textMuted} />
            <BottomSheetTextInput
              style={[styles.addInput, { color: colors.text }]}
              value={addText}
              onChangeText={setAddText}
              placeholder="Add item — “side of toast”"
              placeholderTextColor={colors.textMuted}
              onSubmitEditing={handleAddItem}
              returnKeyType="done"
              editable={!adding}
            />
            {adding ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : addText.trim().length > 0 ? (
              <Pressable onPress={handleAddItem} hitSlop={8} accessibilityLabel="Add item">
                <Ionicons name="arrow-up-circle" size={22} color={colors.primary} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Whole-plate multiplier */}
        <View style={styles.multRow}>
          <Text style={[styles.multLabel, { color: colors.textMuted }]}>Portion</Text>
          <View style={styles.multChips}>
            {PLATE_MULTIPLIERS.map((m) => {
              const selected = plateMult === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => {
                    setPlateMult(m);
                    if (m !== 1) onEdited?.('multiplier');
                  }}
                  style={[
                    styles.multChip,
                    {
                      borderColor: selected ? colors.primary : hairline,
                      backgroundColor: selected ? colors.primary + '18' : 'transparent',
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text
                    style={[
                      styles.multChipText,
                      { color: selected ? colors.primary : colors.textMuted },
                    ]}
                  >
                    {m === 0.5 ? '½' : m === 0.75 ? '¾' : `${m}×`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Fix with a note */}
        {canFix ? (
          <View style={[styles.fixBlock, { borderColor: hairline, backgroundColor: cardBg }]}>
            <View style={styles.fixHeader}>
              <Text style={[styles.fixTitle, { color: colors.text }]}>Fix with a note</Text>
              <Text style={[styles.fixCount, { color: colors.textTertiary }]}>
                {fixesRemaining} left
              </Text>
            </View>
            <View style={styles.fixInputRow}>
              <BottomSheetTextInput
                style={[styles.fixInput, { color: colors.text, borderColor: hairline }]}
                value={fixNote}
                onChangeText={setFixNote}
                placeholder={fixPlaceholder}
                placeholderTextColor={colors.textMuted}
                editable={!fixing}
                maxLength={280}
                onSubmitEditing={handleFix}
                returnKeyType="send"
              />
              <Pressable
                onPress={handleFix}
                disabled={fixing || fixNote.trim().length === 0}
                style={[
                  styles.fixBtn,
                  {
                    backgroundColor:
                      fixing || fixNote.trim().length === 0
                        ? stepBg
                        : colors.primary,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Re-analyze with note"
              >
                {fixing ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Ionicons
                    name="sparkles"
                    size={16}
                    color={fixNote.trim().length === 0 ? colors.textTertiary : '#FFFFFF'}
                  />
                )}
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* CTAs — mono primary per design system */}
        <View style={styles.ctaBlock}>
          <Pressable
            onPress={handleLog}
            disabled={logging || drafts.length === 0}
            style={[
              styles.primaryCta,
              {
                backgroundColor: colors.text,
                opacity: logging || drafts.length === 0 ? 0.5 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={mode === 'edit' ? 'Save changes' : 'Log meal'}
          >
            {logging ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.primaryCtaText, { color: colors.background }]}>
                {mode === 'edit' ? 'Save changes' : 'Log meal'}
              </Text>
            )}
          </Pressable>
          <Pressable
            onPress={onRetake}
            style={[styles.secondaryCta, { borderColor: hairline }]}
            accessibilityRole="button"
          >
            <Text style={[styles.secondaryCtaText, { color: colors.text }]}>
              {mode === 'edit' ? 'Cancel' : 'Retake'}
            </Text>
          </Pressable>
        </View>
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 14 },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { width: 48, height: 48, borderRadius: 12 },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1, gap: 2 },
  mealNameInput: { fontSize: 17, fontFamily: 'Montserrat_700Bold', padding: 0 },
  estimateNote: { fontSize: 11, fontFamily: 'Montserrat_500Medium' },

  totalsCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalKcal: { fontSize: 30, fontFamily: 'Montserrat_800ExtraBold', fontVariant: ['tabular-nums'] },
  totalKcalUnit: { fontSize: 14, fontFamily: 'Montserrat_600SemiBold' },
  macroChipRow: { flexDirection: 'row', gap: 6 },
  macroChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    alignItems: 'center',
  },
  macroChipValue: { fontSize: 13, fontFamily: 'Montserrat_700Bold', fontVariant: ['tabular-nums'] },
  macroChipLabel: { fontSize: 9, fontFamily: 'Montserrat_500Medium' },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bannerText: { flex: 1, fontSize: 12, fontFamily: 'Montserrat_500Medium', lineHeight: 16 },

  itemsBlock: { gap: 8 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  itemInfo: { flex: 1, gap: 2 },
  itemName: { fontSize: 14, fontFamily: 'Montserrat_600SemiBold' },
  itemSub: { fontSize: 11, fontFamily: 'Montserrat_500Medium', fontVariant: ['tabular-nums'] },
  itemControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  stepValue: {
    fontSize: 13,
    fontFamily: 'Montserrat_700Bold',
    fontVariant: ['tabular-nums'],
    minWidth: 26,
    textAlign: 'center',
  },
  removeBtn: { marginLeft: 2, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },

  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 42,
  },
  addInput: { flex: 1, fontSize: 13, fontFamily: 'Montserrat_500Medium', padding: 0 },

  multRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  multLabel: { fontSize: 12, fontFamily: 'Montserrat_600SemiBold' },
  multChips: { flexDirection: 'row', gap: 6 },
  multChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 40,
    alignItems: 'center',
  },
  multChipText: { fontSize: 13, fontFamily: 'Montserrat_600SemiBold' },

  fixBlock: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 12,
    gap: 8,
  },
  fixHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fixTitle: { fontSize: 13, fontFamily: 'Montserrat_700Bold' },
  fixCount: { fontSize: 11, fontFamily: 'Montserrat_500Medium' },
  fixInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fixInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Montserrat_500Medium',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  fixBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },

  ctaBlock: { gap: 10, marginTop: 4 },
  primaryCta: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryCtaText: { fontSize: 15, fontFamily: 'Montserrat_700Bold' },
  secondaryCta: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
  },
  secondaryCtaText: { fontSize: 14, fontFamily: 'Montserrat_600SemiBold' },
});
