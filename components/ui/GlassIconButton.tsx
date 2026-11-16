// components/ui/GlassIconButton.tsx
//
// Circular icon button rendered as real Apple Liquid Glass (UIGlassEffect)
// on iOS 26+ builds, falling back to a translucent hairline-bordered circle
// (design-system surface tokens) on Android / older iOS.
//
// Use this for chrome-level controls: close (X), new (+), and similar
// floating buttons. Content-level inline icons should stay plain.

import { Ionicons } from '@expo/vector-icons';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import React from 'react';
import { Pressable, StyleSheet, ViewStyle } from 'react-native';

import { getThemeColors } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';

const HAS_NATIVE_GLASS = isLiquidGlassAvailable();

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  accessibilityLabel: string;
  /** Circle diameter. */
  size?: number;
  iconSize?: number;
  iconColor?: string;
  disabled?: boolean;
  style?: ViewStyle | (ViewStyle | undefined)[];
  hitSlop?: number;
};

export default function GlassIconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 40,
  iconSize,
  iconColor,
  disabled = false,
  style,
  hitSlop = 8,
}: Props) {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const resolvedIconSize = iconSize ?? Math.round(size * 0.55);
  const color = iconColor ?? colors.text;
  const shape: ViewStyle = { width: size, height: size, borderRadius: size / 2 };

  if (HAS_NATIVE_GLASS) {
    return (
      <GlassView
        style={[styles.center, shape, disabled && styles.disabled, style as ViewStyle]}
        glassEffectStyle="regular"
        colorScheme={isDark ? 'dark' : 'light'}
        isInteractive={!disabled}
      >
        <Pressable
          onPress={onPress}
          disabled={disabled}
          hitSlop={hitSlop}
          style={[styles.center, shape]}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
        >
          <Ionicons name={icon} size={resolvedIconSize} color={color} />
        </Pressable>
      </GlassView>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.center,
        shape,
        {
          backgroundColor: colors.backgroundSecondary,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        style as ViewStyle,
      ]}
    >
      <Ionicons name={icon} size={resolvedIconSize} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  disabled: { opacity: 0.4 },
});
