/**
 * PlateCalculatorSheet — "what do I put on the bar?" helper.
 *
 * Shown from the workout player for barbell exercises. Takes a target weight
 * and renders the per-side plate breakdown for a standard bar, with +/-
 * steppers to explore nearby loads. Styled for the light workout canvas
 * (white surface, neutral chips, brand-blue accents).
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  onClose: () => void;
  unit: 'kg' | 'lbs';
  plates: readonly number[];
  barWeight: number;
  initialWeight: number;
}

const fmt = (n: number): string => (Number.isInteger(n) ? n.toString() : n.toFixed(2).replace(/\.?0+$/, ''));

/** Greedy per-side decomposition; returns [plate, count][] heaviest-first. */
function platesPerSide(target: number, barWeight: number, plates: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  let remaining = (target - barWeight) / 2;
  if (remaining <= 0) return out;
  for (const p of [...plates].sort((a, b) => b - a)) {
    let n = 0;
    while (remaining >= p - 0.001) {
      n += 1;
      remaining -= p;
    }
    if (n > 0) out.push([p, n]);
  }
  return out;
}

export default function PlateCalculatorSheet({ visible, onClose, unit, plates, barWeight, initialWeight }: Props) {
  const insets = useSafeAreaInsets();
  const step = unit === 'lbs' ? 5 : 2.5;
  const [weight, setWeight] = useState(Math.max(initialWeight, barWeight));

  useEffect(() => {
    if (visible) setWeight(Math.max(initialWeight, barWeight));
  }, [visible, initialWeight, barWeight]);

  const breakdown = useMemo(() => platesPerSide(weight, barWeight, plates), [weight, barWeight, plates]);
  const perSide = (weight - barWeight) / 2;
  const loadable = weight - barWeight;
  // Exact match check: greedy sum vs needed per-side load
  const greedySum = breakdown.reduce((acc, [p, n]) => acc + p * n, 0);
  const remainder = perSide - greedySum;

  const bump = (dir: 1 | -1) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setWeight((w) => Math.max(barWeight, Math.round((w + dir * step) * 100) / 100));
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close plate calculator" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>Plate Calculator</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color="#111111" />
            </TouchableOpacity>
          </View>

          {/* Target weight stepper */}
          <View style={styles.weightRow}>
            <TouchableOpacity style={styles.stepBtn} onPress={() => bump(-1)} accessibilityLabel={`Decrease weight by ${step} ${unit}`}>
              <Ionicons name="remove" size={22} color="#111111" />
            </TouchableOpacity>
            <View style={styles.weightDisplay}>
              <Text style={styles.weightValue}>{fmt(weight)}</Text>
              <Text style={styles.weightUnit}>{unit}</Text>
            </View>
            <TouchableOpacity style={styles.stepBtn} onPress={() => bump(1)} accessibilityLabel={`Increase weight by ${step} ${unit}`}>
              <Ionicons name="add" size={22} color="#111111" />
            </TouchableOpacity>
          </View>

          <Text style={styles.barLine}>
            {fmt(barWeight)} {unit} bar{loadable > 0 ? ` + ${fmt(loadable)} ${unit} in plates` : ''}
          </Text>

          {/* Per-side breakdown */}
          <Text style={styles.sectionLabel}>Per side</Text>
          {breakdown.length > 0 ? (
            <View style={styles.plateRow}>
              {breakdown.map(([plate, count]) => (
                <View key={plate} style={styles.plateChipWrap}>
                  <View style={[styles.plateChip, plate >= plates[0] && styles.plateChipBig]}>
                    <Text style={[styles.plateChipText, plate >= plates[0] && styles.plateChipTextBig]}>{fmt(plate)}</Text>
                  </View>
                  {count > 1 && <Text style={styles.plateCount}>×{count}</Text>}
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.emptyText}>Empty bar — no plates needed</Text>
          )}

          {remainder > 0.01 && (
            <Text style={styles.remainderText}>
              {fmt(remainder)} {unit}/side can’t be made with standard plates — closest load shown
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#E2E8F0',
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontFamily: 'Montserrat_700Bold',
    color: '#111111',
  },
  weightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    marginBottom: 8,
  },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: '#F3F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  weightDisplay: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    minWidth: 120,
    justifyContent: 'center',
  },
  weightValue: {
    fontSize: 36,
    fontFamily: 'Montserrat_800ExtraBold',
    color: '#111111',
    fontVariant: ['tabular-nums'],
  },
  weightUnit: {
    fontSize: 16,
    fontFamily: 'Montserrat_600SemiBold',
    color: '#666666',
  },
  barLine: {
    textAlign: 'center',
    fontSize: 13,
    fontFamily: 'Montserrat_500Medium',
    color: '#666666',
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 12,
    fontFamily: 'Montserrat_600SemiBold',
    color: '#999999',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  plateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 8,
  },
  plateChipWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  plateChip: {
    minWidth: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: '#EAF3FF',
    borderWidth: 2,
    borderColor: '#2E90FA',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  plateChipBig: {
    minWidth: 52,
    height: 52,
    backgroundColor: '#2E90FA',
    borderColor: '#2E90FA',
  },
  plateChipText: {
    fontSize: 14,
    fontFamily: 'Montserrat_700Bold',
    color: '#1A6FE0',
    fontVariant: ['tabular-nums'],
  },
  plateChipTextBig: {
    color: '#FFFFFF',
  },
  plateCount: {
    fontSize: 14,
    fontFamily: 'Montserrat_700Bold',
    color: '#111111',
  },
  emptyText: {
    fontSize: 14,
    fontFamily: 'Montserrat_500Medium',
    color: '#666666',
    marginBottom: 8,
  },
  remainderText: {
    fontSize: 12,
    fontFamily: 'Montserrat_500Medium',
    color: '#999999',
    marginTop: 4,
  },
});
