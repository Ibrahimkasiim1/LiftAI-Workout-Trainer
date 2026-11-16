import * as Haptics from 'expo-haptics';
import { usePathname, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors } from '@/hooks/useColors';
import { useWorkoutStore } from '@/stores/useWorkoutStore';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const SIZE = 52;
const STROKE = 3.5;
const RADIUS = (SIZE - STROKE * 2) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
};

export default function WorkoutCircularTimer() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const colors = useColors();

  const restEndTime = useWorkoutStore((s) => s.restEndTime);
  const restDurationSeconds = useWorkoutStore((s) => s.restDurationSeconds);
  const clearRestTimer = useWorkoutStore((s) => s.clearRestTimer);

  const computeInitialOffset = () => {
    if (!restEndTime || restDurationSeconds <= 0) return 0;
    const remaining = Math.max(0, (restEndTime - Date.now()) / 1000);
    return CIRCUMFERENCE * (1 - remaining / restDurationSeconds);
  };

  const [tick, setTick] = useState(0);

  const dashOffset = useSharedValue(computeInitialOffset());
  const pulse = useSharedValue(1);
  const doneProgress = useSharedValue(0);

  const isOnWorkoutScreen = pathname === '/workout';

  // Drive 1-second tick — disabled on workout screen to avoid conflicting with GlobalRestTimer
  useEffect(() => {
    if (!restEndTime || isOnWorkoutScreen) return;
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [restEndTime, isOnWorkoutScreen]);

  const remainingSeconds = useMemo(() => {
    if (!restEndTime) return 0;
    return Math.max(0, Math.ceil((restEndTime - Date.now()) / 1000));
  }, [restEndTime, tick]);

  // Animate arc drain
  useEffect(() => {
    const duration = restDurationSeconds > 0 ? restDurationSeconds : 1;
    const filled = CIRCUMFERENCE * (remainingSeconds / duration);
    // dashOffset 0 = full arc visible; CIRCUMFERENCE = empty arc
    dashOffset.value = withTiming(CIRCUMFERENCE - filled, { duration: 950 });
  }, [remainingSeconds, restDurationSeconds]);

  // Pulse label on each second
  useEffect(() => {
    if (remainingSeconds <= 0 || !restEndTime || isOnWorkoutScreen) return;
    pulse.value = withSequence(
      withTiming(1.15, { duration: 0 }),
      withSpring(1, { damping: 8, stiffness: 180 })
    );
  }, [tick]);

  // Turn green and auto-clear when done
  useEffect(() => {
    if (remainingSeconds > 0 || !restEndTime || isOnWorkoutScreen) return;
    doneProgress.value = withTiming(1, { duration: 400 });
    const t = setTimeout(() => {
      clearRestTimer();
      doneProgress.value = 0;
    }, 1500);
    return () => clearTimeout(t);
  }, [remainingSeconds, restEndTime, isOnWorkoutScreen, clearRestTimer]);

  // Reset doneProgress when a new timer starts
  useEffect(() => {
    if (restEndTime) doneProgress.value = 0;
  }, [restEndTime]);

  const PRIMARY = '#2E90FA';
  const DONE_GREEN = '#2E90FA';

  const animatedArcProps = useAnimatedProps(() => ({
    strokeDashoffset: dashOffset.value,
    stroke: interpolateColor(doneProgress.value, [0, 1], [PRIMARY, DONE_GREEN]),
  }));

  const animatedLabelStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  if (isOnWorkoutScreen || !restEndTime) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      pointerEvents="box-none"
      style={[styles.wrapper, { top: insets.top + 8, right: 12 }]}
    >
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          router.back();
        }}
        style={styles.pressable}
      >
        <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
          {/* Background track */}
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={colors.border}
            strokeWidth={STROKE}
            fill="rgba(255,255,255,0.92)"
          />
          {/* Animated progress arc */}
          <AnimatedCircle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            strokeWidth={STROKE}
            fill="transparent"
            strokeDasharray={CIRCUMFERENCE}
            strokeLinecap="round"
            rotation="-90"
            origin={`${SIZE / 2}, ${SIZE / 2}`}
            animatedProps={animatedArcProps}
          />
        </Svg>
        <Animated.View style={[styles.labelWrap, animatedLabelStyle]}>
          <Text style={[styles.label, { color: colors.text }]}>
            {fmt(remainingSeconds)}
          </Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    zIndex: 9999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 6,
  },
  pressable: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelWrap: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
});
