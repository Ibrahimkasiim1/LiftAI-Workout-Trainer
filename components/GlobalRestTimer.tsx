// components/GlobalRestTimer.tsx
//
// Floating in-app rest timer styled as the Dynamic Island pill from the
// paywall: blue icon circle, letterspaced REST label, big countdown, and a
// live progress ring. Always dark (like the real island) so it reads as a
// system surface over both light and dark screens. Tap to dismiss.

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRestTimerNotifications } from '@/hooks/useRestTimerNotifications';
import { useWorkoutStore } from '@/stores/useWorkoutStore';
import { useProGate } from '../hooks/useProGate';
import ProgressRing from './ui/ProgressRing';

const BLUE = '#2E90FA';
const BLUE_LIGHT = '#5AA6FF';

const formatSeconds = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export default function GlobalRestTimer() {
  const insets = useSafeAreaInsets();
  const [tick, setTick] = useState(0);

  const restEndTime = useWorkoutStore((state) => state.restEndTime);
  const currentExerciseName = useWorkoutStore((state) => state.currentExerciseName);
  const upcomingSetNumber = useWorkoutStore((state) => state.upcomingSetNumber);
  const clearRestTimer = useWorkoutStore((state) => state.clearRestTimer);

  useRestTimerNotifications({ restEndTime });

  useEffect(() => {
    if (!restEndTime) return;
    const id = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [restEndTime]);

  const remainingSeconds = useMemo(() => {
    if (!restEndTime) return 0;
    return Math.max(0, Math.ceil((restEndTime - Date.now()) / 1000));
  }, [restEndTime, tick]);

  // Capture the full duration when a new timer starts so the ring can show
  // remaining/total (the store only keeps the end timestamp).
  const totalSecondsRef = useRef(0);
  useEffect(() => {
    if (restEndTime) {
      totalSecondsRef.current = Math.max(1, Math.ceil((restEndTime - Date.now()) / 1000));
    }
  }, [restEndTime]);

  useEffect(() => {
    if (restEndTime && remainingSeconds <= 0) {
      clearRestTimer();
    }
  }, [clearRestTimer, remainingSeconds, restEndTime]);

  const proGate = useProGate();

  if (!restEndTime || remainingSeconds <= 0) return null;

  const ringProgress = remainingSeconds / Math.max(totalSecondsRef.current, remainingSeconds, 1);

  // Free users see the in-app timer but the Dynamic Island / lock-screen widget
  // is Pro-only. Surface a discoverability nudge alongside the timer so they
  // know that's why nothing appears on the lock screen.
  const showDynamicIslandUpsell = !proGate.isPro && Platform.OS === 'ios';

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View
        entering={SlideInDown.springify().damping(18)}
        exiting={SlideOutDown.duration(180)}
        style={[styles.container, { bottom: Math.max(insets.bottom + 10, 22) }]}
      >
        <Pressable
          style={styles.pill}
          onPress={clearRestTimer}
          accessibilityRole="button"
          accessibilityLabel="Dismiss rest timer"
        >
          <View style={styles.iconCircle}>
            <Ionicons name="barbell" size={18} color="#FFFFFF" />
          </View>
          <View style={styles.center}>
            <Text style={styles.label}>
              REST{upcomingSetNumber != null ? ` · SET ${upcomingSetNumber}` : ''}
            </Text>
            <Text style={styles.time}>{formatSeconds(remainingSeconds)}</Text>
            {currentExerciseName ? (
              <Text numberOfLines={1} style={styles.exercise}>
                {currentExerciseName}
              </Text>
            ) : null}
          </View>
          <ProgressRing size={44} progress={ringProgress} />
        </Pressable>
        {showDynamicIslandUpsell && (
          <Pressable
            onPress={() => proGate.showPaywall('dynamic_island')}
            style={styles.upsell}
            accessibilityRole="button"
            accessibilityLabel="Unlock Dynamic Island rest timer with Pro"
          >
            <Ionicons name="sparkles" size={12} color={BLUE_LIGHT} />
            <Text style={styles.upsellText}>
              See the exercise on your Lock Screen & Dynamic Island
            </Text>
            <Ionicons name="chevron-forward" size={12} color="rgba(255,255,255,0.45)" />
          </Pressable>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    left: 16,
    right: 16,
    position: 'absolute',
    alignItems: 'center',
  },
  // The paywall island pill, verbatim: near-black, hairline border, blue glow.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#060606',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignSelf: 'stretch',
    shadowColor: BLUE,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 10,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: 'rgba(46,144,250,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
  },
  label: {
    fontFamily: 'Montserrat_700Bold',
    fontSize: 10,
    letterSpacing: 2.5,
    color: BLUE_LIGHT,
  },
  time: {
    fontFamily: 'Montserrat_700Bold',
    fontSize: 24,
    color: '#FFFFFF',
    marginTop: 1,
    fontVariant: ['tabular-nums'],
  },
  exercise: {
    fontFamily: 'Montserrat_500Medium',
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 1,
  },
  upsell: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(6,6,6,0.92)',
    alignSelf: 'stretch',
  },
  upsellText: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'Montserrat_600SemiBold',
    color: '#FFFFFF',
  },
});
