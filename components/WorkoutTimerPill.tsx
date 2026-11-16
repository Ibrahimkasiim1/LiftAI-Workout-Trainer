/**
 * WorkoutTimerPill — the one dynamic control at the TOP-RIGHT of the player
 * (replaces the old bottom QuickLogBar, which floated over page content).
 *
 * Work phase:   (  Log set 2 of 4 · 3:24 )
 *   Ticking clock = time on this exercise. Tap = log the prefilled set
 *   (rest starts automatically). Long-press = open the set editor.
 *   While the save is in flight the pill disables and shows a spinner.
 *
 * Rest phase:   ( ◔0:42  +30s )
 *   Circular ring drains with the countdown (Stories/"Ad break" style).
 *   Tap the ring/clock = skip rest and get to the next set; the +30s zone
 *   extends the rest.
 *
 * The countdown/elapsed clocks tick INSIDE this memo'd component (derived
 * from stable timestamps), so the parent never re-renders per second —
 * same invariant the QuickLogBar upheld.
 */

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

interface Props {
  isResting: boolean;
  /** Epoch ms the rest ends — stable for the whole rest period. */
  restEndTime: number | null;
  /** Full rest duration in seconds (for the ring). */
  restDuration: number;
  setNumber: number;
  totalSets: number;
  /** Epoch ms this exercise was started — drives the elapsed clock. */
  exerciseStartedAt: number;
  /** When false (e.g. dumbbell with no weight known yet) tap opens the editor. */
  canQuickLog: boolean;
  /** True while a log save is in flight — disables the tap (no double-logs). */
  isLogging?: boolean;
  onQuickLog: () => void;
  onOpenEditor: () => void;
  onSkipRest: () => void;
  onExtendRest: () => void;
}

const formatClock = (totalSeconds: number): string => {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
};

const RING_SIZE = 30;
const RING_STROKE = 3;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R;

const WorkoutTimerPill: React.FC<Props> = ({
  isResting,
  restEndTime,
  restDuration,
  setNumber,
  totalSets,
  exerciseStartedAt,
  canQuickLog,
  isLogging = false,
  onQuickLog,
  onOpenEditor,
  onSkipRest,
  onExtendRest,
}) => {
  // One shared 1s tick drives both clocks — derived from timestamps so it
  // survives backgrounding and never depends on parent re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - exerciseStartedAt) / 1000));
  const remaining = restEndTime ? Math.max(0, Math.ceil((restEndTime - now) / 1000)) : 0;

  // Pulse when rest ends (isResting true → false): "you're up."
  const pulse = useSharedValue(1);
  const wasRestingRef = useRef(isResting);
  useEffect(() => {
    if (wasRestingRef.current && !isResting) {
      pulse.value = withSequence(
        withTiming(1.08, { duration: 160 }),
        withTiming(1, { duration: 160 }),
        withTiming(1.08, { duration: 160 }),
        withTiming(1, { duration: 160 }),
      );
    }
    wasRestingRef.current = isResting;
  }, [isResting, pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  if (isResting && restEndTime) {
    const progress = restDuration > 0 ? Math.min(1, remaining / restDuration) : 0;
    return (
      <Animated.View style={[styles.pill, pulseStyle]}>
        <TouchableOpacity
          style={styles.zone}
          onPress={() => {
            Haptics.selectionAsync();
            onSkipRest();
          }}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={`Resting, ${formatClock(remaining)} left. Tap to skip rest`}
        >
          <View style={styles.ringWrap}>
            <Svg width={RING_SIZE} height={RING_SIZE}>
              <Circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_R}
                stroke="rgba(255,255,255,0.22)"
                strokeWidth={RING_STROKE}
                fill="none"
              />
              <Circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_R}
                stroke="#2E90FA"
                strokeWidth={RING_STROKE}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${RING_C}`}
                strokeDashoffset={RING_C * (1 - progress)}
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
              />
            </Svg>
            <Ionicons name="play-skip-forward" size={11} color="#FFFFFF" style={styles.ringIcon} />
          </View>
          <Text style={styles.clockText}>{formatClock(remaining)}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.extendZone}
          onPress={() => {
            Haptics.selectionAsync();
            onExtendRest();
          }}
          accessibilityRole="button"
          accessibilityLabel="Add 30 seconds of rest"
        >
          <Text style={styles.extendText}>+30s</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  }

  // The verb lives ON the control: "Log set 2 of 4", not a passive status
  // readout — logging is the player's primary action and must read as one.
  return (
    <Animated.View style={[styles.pill, pulseStyle, isLogging && styles.pillBusy]}>
      <TouchableOpacity
        style={styles.zone}
        onPress={canQuickLog ? onQuickLog : onOpenEditor}
        onLongPress={onOpenEditor}
        disabled={isLogging}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityState={{ disabled: isLogging, busy: isLogging }}
        accessibilityLabel={
          isLogging
            ? 'Saving set…'
            : canQuickLog
              ? `Log set ${setNumber} of ${totalSets}, ${formatClock(elapsed)} on this exercise. Tap to log the set`
              : `Log set ${setNumber} of ${totalSets}. Tap to enter weight and reps`
        }
      >
        <View style={styles.checkCircle}>
          {isLogging ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="checkmark" size={16} color="#FFFFFF" />
          )}
        </View>
        <View style={styles.textCol}>
          <Text style={styles.setText}>
            {isLogging ? 'Saving…' : `Log set ${setNumber} of ${totalSets}`}
          </Text>
          <View style={styles.elapsedRow}>
            <Ionicons name="stopwatch-outline" size={10} color="rgba(255,255,255,0.6)" />
            <Text style={styles.elapsedText}>{formatClock(elapsed)}</Text>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  // Frosted-dark pill with a hairline highlight border — the "Ad break" look:
  // compact, floats over any background without stealing the page.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(10,15,26,0.94)',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 5,
    minHeight: 46,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 10,
  },
  pillBusy: {
    opacity: 0.72,
  },
  zone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 5,
    paddingVertical: 5,
  },
  checkCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#2E90FA',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2E90FA',
    shadowOpacity: 0.45,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  textCol: { gap: 1, paddingRight: 8 },
  setText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.1,
    fontVariant: ['tabular-nums'],
  },
  elapsedRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  elapsedText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  ringWrap: { alignItems: 'center', justifyContent: 'center' },
  ringIcon: { position: 'absolute' },
  clockText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    paddingRight: 4,
  },
  extendZone: {
    paddingHorizontal: 11,
    paddingVertical: 12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: 'rgba(255,255,255,0.28)',
  },
  extendText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12.5,
    fontWeight: '700',
  },
});

export default React.memo(WorkoutTimerPill);
