/**
 * CoachTargetStrip — the coach's target card on the workout scroll page.
 *
 * For the CURRENT exercise it shows, per set:
 *   • the target chip ("62.5 kg × 8" with a direction arrow — the progressive-
 *     overload recommendation the logger is prefilled with),
 *   • one personalized coach note (shown only before the first logged set of
 *     the exercise — mid-exercise coaching comes from CoachMessageCard).
 *
 * INFO-ONLY: the strip is deliberately NOT tappable — logging happens through
 * the WorkoutTimerPill (tap = done set; long-press = editor). A tappable strip
 * kept opening the set logger when users just wanted to read it. The X hides
 * the strip for the rest of the current exercise.
 *
 * Design: light card, blue-only accents (brand #2E90FA), amber reserved for
 * deloads, 16px radius. Kept intentionally compact — it sits between the GIF
 * and the exercise pills without stealing the page.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import { AI_COACH_DISCLAIMER } from '../constants/coachDisclaimer';
import type { CoachExerciseNote, SetRecommendation } from '../src/services/progressiveOverload';

export interface GhostSetData {
  weight: number; // already in the user's display unit
  reps: number;
  date: string; // pre-formatted display date
}

interface Props {
  setNumber: number;
  totalSets: number;
  rec: SetRecommendation | null;
  ghost: GhostSetData | null;
  note: CoachExerciseNote | null;
  unit: 'kg' | 'lbs';
  /** 'none' = bodyweight — the target chip hides the weight. */
  isBodyweight: boolean;
  /** X pressed — parent hides the strip for the current exercise. */
  onDismiss: () => void;
}

const fmt = (n: number): string =>
  Number.isInteger(n) ? n.toString() : n.toFixed(1).replace(/\.0$/, '');

const KIND_META: Record<
  NonNullable<SetRecommendation['kind']>,
  { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }
> = {
  increase: { icon: 'arrow-up', color: '#1A6FE0', bg: '#EAF3FF' },
  maintain: { icon: 'remove', color: '#475569', bg: '#F1F5F9' },
  deload: { icon: 'arrow-down', color: '#B45309', bg: '#FEF3E2' },
  new: { icon: 'sparkles', color: '#1A6FE0', bg: '#EAF3FF' },
};

export default function CoachTargetStrip({
  setNumber,
  totalSets,
  rec,
  ghost,
  note,
  unit,
  isBodyweight,
  onDismiss,
}: Props) {
  // ⓘ toggle — the target chip is an AI suggestion; the disclaimer reminds
  // the user it can be wrong and the final call on weight is theirs.
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  // Nothing useful to show yet (recs not loaded) — render nothing rather
  // than an empty shell.
  if (!rec && !ghost && !note) return null;

  const kindMeta = rec ? KIND_META[rec.kind] : KIND_META.maintain;
  const isPR = note?.tone === 'pr';

  return (
    <View style={[styles.card, isPR && styles.cardPR]}>
      {/* Row 1: coach label + set counter, target chip on the right */}
      <View style={styles.headerRow}>
        <View style={styles.coachLabelWrap}>
          <Ionicons name={isPR ? 'trophy' : 'flash'} size={11} color="#2E90FA" />
          <Text style={styles.coachLabel}>LiftAI</Text>
          <Text style={styles.setCounter}>· Set {setNumber}/{totalSets}</Text>
          {rec ? (
            <TouchableOpacity
              onPress={() => setDisclaimerOpen((v) => !v)}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              accessibilityRole="button"
              accessibilityLabel="About AI suggestions"
            >
              <Ionicons
                name="information-circle-outline"
                size={13}
                color={disclaimerOpen ? '#2E90FA' : '#B6C0CD'}
              />
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.headerRight}>
          {rec ? (
            <View style={[styles.targetChip, { backgroundColor: kindMeta.bg }]}>
              <Text style={[styles.targetChipText, { color: kindMeta.color }]}>
                {isBodyweight || rec.weight <= 0
                  ? `${rec.reps} reps`
                  : `${fmt(rec.weight)} ${unit} × ${rec.reps}`}
              </Text>
              <Ionicons name={kindMeta.icon} size={12} color={kindMeta.color} />
            </View>
          ) : null}
          <TouchableOpacity
            onPress={onDismiss}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Hide coach target"
          >
            <Ionicons name="close" size={16} color="#94A3B4" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Row 2: ghost from the previous session */}
      {ghost ? (
        <View style={styles.ghostRow}>
          <Ionicons name="time-outline" size={11} color="#94A3B4" />
          <Text style={styles.ghostText}>
            Last: {isBodyweight ? `${ghost.reps} reps` : `${fmt(ghost.weight)} ${unit} × ${ghost.reps}`}
            <Text style={styles.ghostDate}>  ·  {ghost.date}</Text>
          </Text>
        </View>
      ) : null}

      {/* Row 3: the coach's one-liner */}
      {note ? (
        <Text style={styles.noteText} numberOfLines={2}>
          {note.text}
        </Text>
      ) : null}

      {disclaimerOpen ? (
        <Text style={styles.disclaimerText}>{AI_COACH_DISCLAIMER}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E8EDF3',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 10,
    gap: 5,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardPR: {
    borderColor: '#B9D9FE',
    shadowColor: '#2E90FA',
    shadowOpacity: 0.18,
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  coachLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  coachLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: '#2E90FA',
  },
  setCounter: { fontSize: 10, fontWeight: '600', color: '#94A3B4' },

  targetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  targetChipText: {
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },

  ghostRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  ghostText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8A97A8',
    fontVariant: ['tabular-nums'],
  },
  ghostDate: { fontSize: 11, fontWeight: '500', color: '#B6C0CD' },

  noteText: {
    fontSize: 12,
    lineHeight: 17,
    color: '#475569',
    fontWeight: '500',
  },
  disclaimerText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '500',
    color: '#8A97A8',
    borderTopWidth: 1,
    borderTopColor: '#EEF2F7',
    paddingTop: 6,
  },
});
