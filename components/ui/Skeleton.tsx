/**
 * Skeleton — shared loading-placeholder primitives.
 *
 * One pulse animation drives all blocks on a screen so the shimmer feels
 * coherent. Usage:
 *
 *   const pulse = useSkeletonPulse();
 *   <SkeletonBlock width={120} height={20} pulse={pulse} isDark={isDark} />
 *
 * Or drop-in screen scaffold:
 *   <SkeletonList isDark={isDark} rows={6} />
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, ViewStyle } from 'react-native';

import { borderRadius } from '../../constants/theme';

export function useSkeletonPulse(): Animated.Value {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return pulse;
}

export function SkeletonBlock({
  width,
  height,
  radius = borderRadius.md,
  pulse,
  isDark,
  style,
}: {
  width: number | string;
  height: number;
  radius?: number;
  pulse: Animated.Value;
  isDark: boolean;
  style?: ViewStyle | ViewStyle[];
}) {
  return (
    <Animated.View
      style={[
        {
          width: width as number,
          height,
          borderRadius: radius,
          backgroundColor: isDark ? '#1F1F1F' : '#ECECEC',
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }),
        },
        style,
      ]}
    />
  );
}

/** Generic list-of-rows skeleton for screens without a bespoke layout. */
export function SkeletonList({ isDark, rows = 6, rowHeight = 64 }: { isDark: boolean; rows?: number; rowHeight?: number }) {
  const pulse = useSkeletonPulse();
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 12 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonBlock key={i} width="100%" height={rowHeight} radius={borderRadius.xl} pulse={pulse} isDark={isDark} />
      ))}
    </View>
  );
}
